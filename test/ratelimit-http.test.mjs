// 限流与诊断端点的真 HTTP 集成：429 的写出、XFF 开关、/stat、运行时模式切换、启动拒绝。
//
// worker 用假传输（test/helpers/fake-worker.mjs）：这一层验的是「主进程接线」——
// 真的 TCP、真的分发器与端点处理器，只是计算换成了可确定性的假 worker。
// 端口只用 listen(0)，Windows 上自选端口会撞 TIME_WAIT。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const { startServe } = await import('../src/serve.mjs')
const { serveAuthError } = await import('../src/auth.mjs')
const { createDispatcher } = await import('../src/dispatcher.mjs')
const { FakeWorker } = await import('./helpers/fake-worker.mjs')

const token = 'test-token'
const running = []
const tempDirs = []

after(async () => {
    for (const entry of running) {
        await entry.pool.stop()
        await new Promise(resolve => entry.server.close(resolve))
    }
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function until(condition, describe, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
        const poll = async () => {
            try {
                if (await condition()) return resolve()
            } catch (error) {
                return reject(error)
            }
            if (Date.now() > deadline) return reject(new Error(`等不到：${describe}`))
            setTimeout(poll, 10)
        }
        poll()
    })
}

const signPayload = () => ({
    url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088&device_id=7000000000000001',
    method: 'POST',
    body: '{"track_id":"1"}',
    headers: { 'x-ss-stub': 'ABC', cookie: 'sid=1' },
})

async function start({ env = {}, config = {}, ready = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-rate-'))
    tempDirs.push(dir)
    const workers = []
    const notes = []
    const modeFile = path.join(dir, 'rate-limit.mode')
    const entry = startServe({
        config: {
            version: 'test',
            host: '127.0.0.1',
            token,
            deviceId: '7000000000000001',
            maxBodyBytes: 256 * 1024,
            identityFile: path.join(dir, 'identity.json'),
            trustProxy: false,
            ...config,
        },
        env: {
            LIBMSSDK_WORKERS: '1',
            LIBMSSDK_WAIT_BUDGET_MS: '5000',
            LIBMSSDK_RATE_LIMIT_MODE_FILE: modeFile,
            ...env,
        },
        log: (event, detail) => notes.push({ event, detail }),
        spawn: index => {
            const worker = new FakeWorker(index)
            workers.push(worker)
            if (ready) setImmediate(() => worker.reportReady())
            return worker
        },
    })
    entry.workers = workers
    entry.notes = notes
    entry.modeFile = modeFile
    running.push(entry)
    await new Promise(resolve => entry.server.listen(0, '127.0.0.1', resolve))
    entry.baseUrl = `http://127.0.0.1:${entry.server.address().port}`
    if (ready) await until(() => entry.pool.readyCount === 1, '假 worker 就绪')
    return entry
}

async function post(entry, payload, headers = {}) {
    const response = await fetch(`${entry.baseUrl}/sign`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            ...headers,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
    })
    return { status: response.status, headers: response.headers, text: await response.text() }
}

async function getJson(entry, pathname) {
    const response = await fetch(`${entry.baseUrl}${pathname}`, { signal: AbortSignal.timeout(5000) })
    return { status: response.status, body: await response.json() }
}

const signCount = entry => entry.workers[0].sent.filter(message => message.type === 'sign').length

/** 发一条 /sign 并让假 worker 立刻回成功；返回客户端读到的回包。 */
async function signOnce(entry, headers = {}) {
    const before = signCount(entry)
    const pending = post(entry, signPayload(), headers)
    await until(() => signCount(entry) > before, '请求被派发到 worker')
    entry.workers[0].reportResult()
    return pending
}

test('单 IP 超限回 429 与等待时长；/stat 暴露计数且地址脱敏', async () => {
    const entry = await start({ env: { LIBMSSDK_RATE_LIMIT_PER_SECOND: '0.001', LIBMSSDK_RATE_LIMIT_BURST: '1' } })
    assert.equal((await signOnce(entry)).status, 200)

    const blocked = await post(entry, signPayload())
    assert.equal(blocked.status, 429)
    const body = JSON.parse(blocked.text)
    assert.equal(body.code, 'RATE_LIMITED')
    assert.equal(blocked.headers.get('retry-after'), String(body.retry_after_seconds), '头与体必须是同一个整数')
    assert.ok(body.retry_after_seconds >= 1, '等待时长向上取整，最少 1 秒')
    assert.equal(entry.pool.busyCount, 0, '被限流的请求不该占 worker')

    const stat = (await getJson(entry, '/stat')).body
    assert.equal(stat.ok, true)
    assert.equal(stat.workers.total, 1, '当前 worker 数')
    assert.equal(stat.workers.ready, 1)
    assert.equal(stat.workers.busy, 0, '空闲时没有在飞的签名')
    assert.equal(stat.queue.depth, 0, '队列深度')
    assert.equal(stat.rateLimit.mode, 'enforce')
    assert.equal(stat.rateLimit.activeBuckets, 1, '活跃桶数')
    assert.ok(stat.rateLimit.allowed >= 1)
    assert.equal(stat.rateLimit.denied, 1)
    assert.equal(stat.rateLimit.top[0].address, '127.0.*.*')
    assert.ok(!JSON.stringify(stat).includes('127.0.0.1'), '/stat 里不能出现完整 IP')

    // /stat 自己不参与限流计数
    const again = (await getJson(entry, '/stat')).body
    assert.equal(again.rateLimit.allowed, stat.rateLimit.allowed)
    assert.equal(again.rateLimit.denied, stat.rateLimit.denied)
})

test('默认不信任 X-Forwarded-For；显式打开后按 XFF 最右一跳分桶', async () => {
    const untrusted = await start({ env: { LIBMSSDK_RATE_LIMIT_PER_SECOND: '0.001', LIBMSSDK_RATE_LIMIT_BURST: '1' } })
    assert.equal((await signOnce(untrusted, { 'x-forwarded-for': '198.51.100.1' })).status, 200)
    const ignored = await post(untrusted, signPayload(), { 'x-forwarded-for': '198.51.100.2' })
    assert.equal(ignored.status, 429, '开关关闭时只认 TCP 对端：换 XFF 不换桶')

    const trusted = await start({
        config: { trustProxy: true },
        env: { LIBMSSDK_RATE_LIMIT_PER_SECOND: '0.001', LIBMSSDK_RATE_LIMIT_BURST: '1' },
    })
    assert.equal(trusted.notes.find(note => note.event === 'dispatcher').detail.trustProxy, true, '启动日志要写出信任 XFF')
    // 运行时核对这项部署开关：#9 删掉了明文返回整套设备身份的 /config，开关挪进 /stat
    const trustedStat = await getJson(trusted, '/stat')
    assert.equal(trustedStat.body.rateLimit.trustProxy, true, '/stat 要能核对这项部署开关')
    assert.equal((await signOnce(trusted, { 'x-forwarded-for': '198.51.100.1' })).status, 200)
    assert.equal((await signOnce(trusted, { 'x-forwarded-for': '198.51.100.2' })).status, 200, '不同 XFF 是两个桶')
    const repeat = await post(trusted, signPayload(), { 'x-forwarded-for': '198.51.100.1' })
    assert.equal(repeat.status, 429, '同一个 XFF 仍然受限')
})

test('服务忙回 503 BUSY，与「你打太多」的 429 明确区分', async () => {
    const entry = await start({
        env: { LIBMSSDK_RATE_LIMIT_BURST: '1000', LIBMSSDK_QUEUE_LIMIT: '1' },
    })
    const first = post(entry, signPayload())
    await until(() => signCount(entry) === 1, '第一条正在 worker 上算')
    const duringSign = (await getJson(entry, '/stat')).body
    assert.equal(duringSign.workers.busy, 1, '/stat 能看出正在算的那台')

    const queued = post(entry, signPayload())
    await until(async () => (await getJson(entry, '/stat')).body.queue.depth === 1, '第二条进了队列')

    const rejected = await post(entry, signPayload())
    assert.equal(rejected.status, 503)
    const body = JSON.parse(rejected.text)
    assert.equal(body.code, 'BUSY')
    assert.equal(rejected.headers.get('retry-after'), '1')

    entry.workers[0].reportResult()
    await until(() => signCount(entry) === 2, '腾出的槽位接住排队的那条')
    entry.workers[0].reportResult()
    assert.equal((await first).status, 200)
    assert.equal((await queued).status, 200)
})

test('/stat 在预热中也能回答：诊断不依赖 worker 就绪', async () => {
    const entry = await start({ ready: false })
    const stat = (await getJson(entry, '/stat')).body
    assert.equal(stat.ok, true)
    assert.equal(stat.workers.total, 1)
    assert.equal(stat.workers.ready, 0)
    assert.equal(stat.queue.depth, 0)
    assert.equal(stat.rateLimit.activeBuckets, 0)
})

test('运行时切成只记日志或关闭：改控制文件即可，不用重启', async () => {
    const entry = await start({
        env: {
            LIBMSSDK_RATE_LIMIT_PER_SECOND: '0.001',
            LIBMSSDK_RATE_LIMIT_BURST: '1',
            LIBMSSDK_RATE_LIMIT_MODE_POLL_MS: '100',
        },
    })
    assert.equal((await signOnce(entry)).status, 200)
    assert.equal((await post(entry, signPayload())).status, 429, '默认是强制')

    fs.writeFileSync(entry.modeFile, 'log\n')
    await until(async () => (await getJson(entry, '/stat')).body.rateLimit.mode === 'log', '切到 log')
    assert.equal((await signOnce(entry)).status, 200, '只记日志时不拦')
    const logged = (await getJson(entry, '/stat')).body
    assert.ok(logged.rateLimit.denied >= 2, '仍然计入「本该拒绝」')
    assert.ok(
        entry.notes.some(note => note.event === 'rate-limited' && note.detail.mode === 'log'),
        '只记日志时要留下可检索的记录',
    )
    assert.ok(!JSON.stringify(entry.notes.filter(note => note.event === 'rate-limited')).includes('127.0.0.1'), '日志里的地址同样脱敏')

    fs.writeFileSync(entry.modeFile, 'off\n')
    await until(async () => (await getJson(entry, '/stat')).body.rateLimit.mode === 'off', '切到 off')
    assert.equal((await signOnce(entry)).status, 200)
    const off = (await getJson(entry, '/stat')).body
    assert.equal(off.rateLimit.activeBuckets, logged.rateLimit.activeBuckets, 'off 不新建桶')
    assert.equal(off.rateLimit.allowed, logged.rateLimit.allowed, 'off 不计数')
})

test('绑定非回环且没有令牌：拒绝启动并给出明确原因，且不会先 fork worker', () => {
    let spawned = 0
    assert.throws(
        () =>
            startServe({
                config: { version: 'test', host: '0.0.0.0', token: '', deviceId: '1', identityFile: '' },
                env: { LIBMSSDK_WORKERS: '1' },
                spawn: () => {
                    spawned += 1
                    return new FakeWorker()
                },
            }),
        /LIBMSSDK_TOKEN/,
    )
    assert.equal(spawned, 0, '检查在 fork 之前')

    assert.match(serveAuthError({ host: '0.0.0.0', token: '' }), /LIBMSSDK_TOKEN/)
    assert.match(serveAuthError({ host: '::', token: '' }), /LIBMSSDK_TOKEN/)
    assert.equal(serveAuthError({ host: '127.0.0.1', token: '' }), null)
    assert.equal(serveAuthError({ host: '127.0.0.2', token: '' }), null, '整个 127/8 都是本机')
    assert.equal(serveAuthError({ host: '::1', token: '' }), null)
    assert.equal(serveAuthError({ host: 'localhost', token: '' }), null)
    assert.equal(serveAuthError({ host: '0.0.0.0', token: 'secret' }), null)

    // 直接构造的嵌入用法也守同一条规则，而不是只有 CLI 的 serve 才检查
    const openConfig = { version: 'test', host: '0.0.0.0', token: '', deviceId: '1' }
    assert.throws(() => createDispatcher({ config: openConfig, pool: { size: 1 } }), /LIBMSSDK_TOKEN/)
})
