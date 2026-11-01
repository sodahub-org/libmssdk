// 限流器的纯函数单测：GCRA 状态转移、桶回收与上限、IPv4/IPv6 分桶、地址脱敏、XFF 开关。
//
// 时间全部从参数进来，所以这些用例不需要假时钟、也不会在慢 CI 上抖。

import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
    RATE_LIMIT_DEFAULTS,
    addressKey,
    clientKey,
    createRateLimiter,
    forwardedAddress,
    maskAddressKey,
    normalizeAddress,
    normalizeMode,
    rateLimitSettingsFromEnv,
} = await import('../src/ratelimit.mjs')
const { retryAfterFromInstant } = await import('../src/errors.mjs')
const { loadConfig } = await import('../src/config.mjs')

const request = (remoteAddress, forwarded) => ({
    socket: { remoteAddress },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
})

test('默认参数宽松可用；非法环境变量退回默认而不是把限流关掉', () => {
    const defaults = rateLimitSettingsFromEnv({})
    assert.equal(defaults.ratePerSecond, RATE_LIMIT_DEFAULTS.ratePerSecond)
    assert.equal(defaults.burst, RATE_LIMIT_DEFAULTS.burst)
    assert.equal(defaults.maxBuckets, RATE_LIMIT_DEFAULTS.maxBuckets)
    assert.equal(defaults.mode, 'enforce', '默认强制生效')
    assert.equal(defaults.pollMs, RATE_LIMIT_DEFAULTS.pollMs)

    const custom = rateLimitSettingsFromEnv({
        LIBMSSDK_RATE_LIMIT_PER_SECOND: '2.5',
        LIBMSSDK_RATE_LIMIT_BURST: '30',
        LIBMSSDK_RATE_LIMIT_MAX_BUCKETS: '64',
        LIBMSSDK_RATE_LIMIT_MODE: 'log',
        LIBMSSDK_RATE_LIMIT_MODE_FILE: '/tmp/mode',
        LIBMSSDK_RATE_LIMIT_MODE_POLL_MS: '50',
    })
    assert.deepEqual(custom, {
        ratePerSecond: 2.5,
        burst: 30,
        maxBuckets: 64,
        mode: 'log',
        modeFile: '/tmp/mode',
        pollMs: 50,
    })

    const broken = rateLimitSettingsFromEnv({
        LIBMSSDK_RATE_LIMIT_PER_SECOND: 'abc',
        LIBMSSDK_RATE_LIMIT_BURST: '0',
        LIBMSSDK_RATE_LIMIT_MAX_BUCKETS: '-1',
        LIBMSSDK_RATE_LIMIT_MODE: 'wat',
        LIBMSSDK_RATE_LIMIT_MODE_POLL_MS: 'nope',
    })
    assert.equal(broken.ratePerSecond, RATE_LIMIT_DEFAULTS.ratePerSecond)
    assert.equal(broken.burst, RATE_LIMIT_DEFAULTS.burst)
    assert.equal(broken.maxBuckets, RATE_LIMIT_DEFAULTS.maxBuckets)
    assert.equal(broken.mode, 'enforce')
    assert.equal(broken.pollMs, RATE_LIMIT_DEFAULTS.pollMs)
    assert.equal(normalizeMode(' LOG '), 'log')
    assert.equal(normalizeMode('bogus'), null)
})

test('IPv4 按单地址、IPv6 按 /64 聚合；IPv4-mapped 折回 IPv4', () => {
    assert.equal(normalizeAddress('::ffff:203.0.113.9'), '203.0.113.9')
    assert.equal(normalizeAddress('::ffff:cb00:7109'), '203.0.113.9', 'mapped 的十六进制写法也要折回')
    assert.equal(addressKey('203.0.113.9'), 'v4:203.0.113.9')
    assert.equal(addressKey('::ffff:203.0.113.9'), 'v4:203.0.113.9')
    assert.equal(addressKey('::ffff:cb00:7109'), 'v4:203.0.113.9')
    assert.notEqual(addressKey('203.0.113.10'), addressKey('203.0.113.9'), 'IPv4 不聚合')

    assert.equal(addressKey('2001:DB8:1:2:3:4:5:6'), 'v6:2001:db8:1:2::/64')
    assert.equal(addressKey('2001:db8:1:2:ffff::1'), 'v6:2001:db8:1:2::/64', '同一个 /64 共用一个桶')
    assert.notEqual(addressKey('2001:db8:1:3::1'), addressKey('2001:db8:1:2::1'), '不同 /64 分开')
    assert.equal(addressKey('::1'), addressKey('::2'), '回环地址也按 /64 聚合')
    assert.equal(addressKey('fe80::1%eth0'), addressKey('fe80::1'), 'zone id 不参与分桶')
    assert.equal(addressKey('[2001:db8::1]'), addressKey('2001:db8::1'))
    assert.equal(addressKey('not-an-ip'), 'unknown')
    assert.equal(addressKey(''), 'unknown')
})

test('诊断与日志里的地址只留前缀，不出现完整地址', () => {
    assert.equal(maskAddressKey('v4:203.0.113.9'), '203.0.*.*')
    assert.equal(maskAddressKey('v6:2001:db8:1:2::/64'), '2001:db8:****::/64')
    assert.equal(maskAddressKey('unknown'), 'unknown')

    const masked = maskAddressKey(addressKey('2001:db8:1:2:3:4:5:6'))
    assert.ok(!masked.includes('3:4:5:6'), `IPv6 尾部不该出现：${masked}`)
    assert.ok(!maskAddressKey(addressKey('203.0.113.9')).includes('113.9'))
})

test('X-Forwarded-For 只在显式信任时生效；生效时取最右边一跳', () => {
    const peer = '198.51.100.7'
    assert.equal(clientKey(request(peer, '203.0.113.1'), { trustProxy: false }), 'v4:198.51.100.7')
    assert.equal(clientKey(request(peer, '203.0.113.1'), { trustProxy: true }), 'v4:203.0.113.1')
    assert.equal(
        clientKey(request(peer, '203.0.113.1, 203.0.113.2'), { trustProxy: true }),
        'v4:203.0.113.2',
        '最右边是直接对端反代亲眼看到的那一跳，左边可被调用方伪造',
    )
    assert.equal(clientKey(request(peer, 'garbage, 203.0.113.3'), { trustProxy: true }), 'v4:203.0.113.3')
    assert.equal(
        clientKey(request(peer, 'garbage'), { trustProxy: true }),
        'v4:198.51.100.7',
        'XFF 全是垃圾时退回可验证的 TCP 对端',
    )
    assert.equal(
        clientKey(request('::ffff:cb00:7109'), { trustProxy: false }),
        'v4:203.0.113.9',
        '双栈监听下的 mapped 对端也要折回 IPv4',
    )
    assert.equal(forwardedAddress(undefined), '')
    assert.equal(clientKey({ headers: {} }, { trustProxy: true }), 'unknown')
})

test('LIBMSSDK_TRUST_PROXY 是显式开关，默认关闭', () => {
    const savedTrust = process.env.LIBMSSDK_TRUST_PROXY
    const savedDevice = process.env.LIBMSSDK_DEVICE_ID
    // 钉死设备号，避免这个用例去碰 state 目录
    process.env.LIBMSSDK_DEVICE_ID = '7000000000000001'
    try {
        delete process.env.LIBMSSDK_TRUST_PROXY
        assert.equal(loadConfig().trustProxy, false, '默认只认 TCP 对端地址')
        for (const value of ['1', 'true', 'yes', 'on']) {
            process.env.LIBMSSDK_TRUST_PROXY = value
            assert.equal(loadConfig().trustProxy, true, `LIBMSSDK_TRUST_PROXY=${value}`)
        }
        process.env.LIBMSSDK_TRUST_PROXY = '0'
        assert.equal(loadConfig().trustProxy, false)
    } finally {
        if (savedTrust === undefined) delete process.env.LIBMSSDK_TRUST_PROXY
        else process.env.LIBMSSDK_TRUST_PROXY = savedTrust
        if (savedDevice === undefined) delete process.env.LIBMSSDK_DEVICE_ID
        else process.env.LIBMSSDK_DEVICE_ID = savedDevice
    }
})

test('GCRA：突发边界、补充、精确的下次可请求时刻', () => {
    const now = 1_000_000
    const limiter = createRateLimiter({ ratePerSecond: 0.5, burst: 12, maxBuckets: 100 })

    for (let index = 0; index < 12; index += 1) {
        assert.equal(limiter.check('v4:a', now).allowed, true, `第 ${index + 1} 次在突发额度内`)
    }
    const blocked = limiter.check('v4:a', now)
    assert.equal(blocked.allowed, false, '第 13 次超限')
    assert.equal(blocked.retryAtMs, now + 2000, '0.5 次/秒 = 每个间隔 2 秒')
    assert.equal(retryAfterFromInstant(blocked.retryAtMs, now), 2)

    // 差 1 毫秒：仍然拒，但等待向上取整至少 1 秒
    const almost = createRateLimiter({ ratePerSecond: 0.5, burst: 12, maxBuckets: 100 })
    for (let index = 0; index < 12; index += 1) almost.check('v4:a', now)
    const nearly = almost.check('v4:a', now + 1999)
    assert.equal(nearly.allowed, false)
    assert.equal(nearly.retryAtMs, now + 2000)
    assert.equal(retryAfterFromInstant(nearly.retryAtMs, now + 1999), 1)

    // 正好到点就放行：边界不是「大于」而是「大于等于」
    assert.equal(limiter.check('v4:a', now + 2000).allowed, true)

    // 之后按间隔补充：再等 2 秒又能放行一次
    assert.equal(limiter.check('v4:a', now + 2000).allowed, false, '同一时刻只补充了一个额度')
    assert.equal(limiter.check('v4:a', now + 4000).allowed, true)
})

test('多键隔离：一个地址打满不影响另一个', () => {
    const limiter = createRateLimiter({ ratePerSecond: 1, burst: 1, maxBuckets: 100 })
    assert.equal(limiter.check('v4:a', 1000).allowed, true)
    assert.equal(limiter.check('v4:a', 1000).allowed, false)
    assert.equal(limiter.check('v4:b', 1000).allowed, true, '另一个地址是独立的桶')
    assert.equal(limiter.stats().activeBuckets, 2)
})

test('log 模式照常判定与计数但不拒；off 模式完全不参与', () => {
    const logLimiter = createRateLimiter({ ratePerSecond: 1, burst: 1, mode: 'log' })
    assert.equal(logLimiter.check('v4:a', 1000).allowed, true)
    const wouldDeny = logLimiter.check('v4:a', 1000)
    assert.equal(wouldDeny.wouldDeny, true)
    assert.equal(wouldDeny.allowed, true, '只记日志时不拦')
    assert.equal(logLimiter.stats().denied, 1)
    assert.equal(logLimiter.stats().mode, 'log')
    assert.equal(logLimiter.setMode('enforce'), true)
    assert.equal(logLimiter.check('v4:a', 1000).allowed, false, '切回强制后同一时刻就拦')

    const offLimiter = createRateLimiter({ ratePerSecond: 1, burst: 1, mode: 'off' })
    for (let index = 0; index < 20; index += 1) assert.equal(offLimiter.check('v4:a', 1000).allowed, true)
    assert.equal(offLimiter.stats().activeBuckets, 0, 'off 模式不建桶')
    assert.equal(offLimiter.stats().allowed, 0)
    assert.equal(offLimiter.stats().denied, 0)
    assert.equal(offLimiter.setMode('nonsense'), false)
    assert.equal(offLimiter.mode, 'off')
})

test('桶总数封顶：超出时挤掉最久没动的桶，内存不随地址数增长', () => {
    const limiter = createRateLimiter({ ratePerSecond: 1, burst: 1, maxBuckets: 2 })
    assert.equal(limiter.check('v4:a', 1000).allowed, true)
    assert.equal(limiter.check('v4:b', 1000).allowed, true)
    limiter.check('v4:a', 1000) // 访问 a，把它挪到 LRU 队尾（这次超限，但顺序要更新）
    limiter.check('v4:c', 1000)
    assert.equal(limiter.stats().activeBuckets, 2)
    assert.equal(limiter.stats().evicted, 1, '满了以后腾位置，而不是无界增长')

    for (let index = 0; index < 5000; index += 1) {
        limiter.check(`v4:10.0.${Math.floor(index / 250)}.${index % 250}`, 1000)
    }
    assert.ok(limiter.stats().activeBuckets <= 2, `活跃桶不能超过上限：${limiter.stats().activeBuckets}`)
    assert.ok(limiter.stats().evicted > 0)
})

test('过期桶会被回收：连续扫描不改变计数，内存不单调上涨', () => {
    const limiter = createRateLimiter({ ratePerSecond: 2, burst: 1, maxBuckets: 10 })
    limiter.check('v4:a', 1000) // tat = 1500
    limiter.check('v4:b', 1001)
    limiter.sweep(1499)
    assert.equal(limiter.stats().activeBuckets, 2, '还有欠账时不能回收')
    limiter.sweep(1500)
    assert.equal(limiter.stats().activeBuckets, 1, 'a 已还清，回收')
    limiter.sweep(1501)
    assert.equal(limiter.stats().activeBuckets, 0)
    const before = limiter.stats()
    limiter.sweep(2000)
    assert.deepEqual(limiter.stats(), before, '再次扫描不改变统计')

    // 反复「打满 → 全部过期」不留下任何桶
    for (let round = 0; round < 5; round += 1) {
        const at = 10_000 + round * 10_000
        for (let index = 0; index < 20; index += 1) limiter.check(`v4:203.0.113.${index}`, at)
        assert.equal(limiter.stats().activeBuckets, 10, '桶数封顶')
        limiter.sweep(at + 10_000)
        assert.equal(limiter.stats().activeBuckets, 0, '整轮过期后清空')
    }
})
