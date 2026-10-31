// 按客户端地址限流：GCRA（每个桶只存一个时间戳），以及分桶键要用的地址归一化与脱敏。
//
// 为什么键是 TCP 对端地址而不是令牌：令牌写在公开的客户端源码里，不是凭据，谁都能换一个；
// 对端地址是服务端能验证的东西。IPv4 按单地址、IPv6 按 /64 聚合 —— 不给 IPv6 聚合的话，
// 换一个地址就烧一个新桶，等于没限流。
//
// 阈值故意宽松（默认 0.5 次/秒、突发 12）：共享出口后面几十个人共用一个地址，紧阈值会把
// 整栋楼的人一起挡在门外。桶总数封顶，满了挤掉最久没动过的那个，内存不会随地址数上涨。
//
// 时间不做成接缝：check / sweep 都把当前时刻当参数收进来，模块自己不读墙上时钟。
// 定时器只负责用当前时间去调它们（见 src/dispatcher.mjs），测试不需要假时钟。

import net from 'node:net'
import { parsePositiveInt } from './dispatch.mjs'

export const RATE_LIMIT_DEFAULTS = Object.freeze({
    ratePerSecond: 0.5,
    burst: 12,
    maxBuckets: 4096,
    mode: 'enforce',
    pollMs: 2000,
})

export const RATE_LIMIT_MODES = Object.freeze(['enforce', 'log', 'off'])

/** 限流模式：只认三个稳定字符串，认不出来返回 fallback（默认 null）。 */
export function normalizeMode(raw, fallback = null) {
    const mode = String(raw ?? '').trim().toLowerCase()
    return RATE_LIMIT_MODES.includes(mode) ? mode : fallback
}

function parsePositiveNumber(raw, fallback) {
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 从环境变量读限流参数。非法值一律退回默认，而不是退回「0」或「关闭」：
 * 一个手抖写错的数字不该悄无声息地把限流关掉。
 */
export function rateLimitSettingsFromEnv(env = {}) {
    const pick = key => String(env[key] ?? '').trim()
    return {
        ratePerSecond: parsePositiveNumber(pick('LIBMSSDK_RATE_LIMIT_PER_SECOND'), RATE_LIMIT_DEFAULTS.ratePerSecond),
        burst: parsePositiveInt(pick('LIBMSSDK_RATE_LIMIT_BURST'), RATE_LIMIT_DEFAULTS.burst),
        maxBuckets: parsePositiveInt(pick('LIBMSSDK_RATE_LIMIT_MAX_BUCKETS'), RATE_LIMIT_DEFAULTS.maxBuckets),
        mode: normalizeMode(pick('LIBMSSDK_RATE_LIMIT_MODE'), RATE_LIMIT_DEFAULTS.mode),
        modeFile: pick('LIBMSSDK_RATE_LIMIT_MODE_FILE'),
        pollMs: parsePositiveInt(pick('LIBMSSDK_RATE_LIMIT_MODE_POLL_MS'), RATE_LIMIT_DEFAULTS.pollMs),
    }
}

/** 去掉方括号与 zone id：`[::1]` / `fe80::1%eth0` 都是同一个口的同一种地址。 */
function stripBracketsAndZone(raw) {
    let value = String(raw ?? '').trim()
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
    const zone = value.indexOf('%')
    return zone >= 0 ? value.slice(0, zone) : value
}

/**
 * 归一化成一个可比较的地址：IPv4 原样，IPv4-mapped IPv6（`::ffff:1.2.3.4`）折回 IPv4，
 * 其余 IPv6 转小写。认不出来返回 ''，由调用方决定退回对端地址还是归进 unknown 桶。
 */
export function normalizeAddress(raw) {
    const value = stripBracketsAndZone(raw)
    if (!value) return ''
    if (net.isIPv4(value)) return value
    if (!net.isIPv6(value)) return ''
    const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
    if (mapped && net.isIPv4(mapped[1])) return mapped[1]
    return value.toLowerCase()
}

/** 展开成 8 个 16 位分组；`::` 靠补零补齐。net.isIPv6 已经验过格式，这里只做拆分。 */
function ipv6Groups(ip) {
    const halves = ip.split('::')
    if (halves.length > 2) return null
    const expand = part => {
        if (!part) return []
        const groups = []
        for (const piece of part.split(':')) {
            if (!piece.includes('.')) {
                groups.push(piece)
                continue
            }
            const octets = piece.split('.').map(Number)
            if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
                return null
            }
            groups.push(((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16))
        }
        return groups
    }
    const left = expand(halves[0])
    const right = halves.length === 2 ? expand(halves[1]) : []
    if (!left || !right) return null
    const missing = 8 - left.length - right.length
    if (missing < 0) return null
    const groups = [...left, ...Array(missing).fill('0'), ...right].map(group => Number.parseInt(group, 16))
    if (groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null
    return groups
}

/**
 * 分桶键：IPv4 一个地址一个桶，IPv6 一个 /64 一个桶；认不出来的地址共用一个 unknown 桶。
 * 返回的是「可比较的键」，不是要展示的地址 —— 展示走 maskAddressKey。
 */
export function addressKey(raw) {
    const ip = normalizeAddress(raw)
    if (!ip) return 'unknown'
    if (net.isIPv4(ip)) return `v4:${ip}`
    const groups = ipv6Groups(ip)
    if (!groups) return 'unknown'
    return `v6:${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`
}

/** 诊断输出与日志里只留前缀：IPv4 留两段、IPv6 留两个 hextet，足够看出「是谁的网段」而不暴露主机。 */
export function maskAddressKey(key) {
    const text = String(key ?? '')
    if (text.startsWith('v4:')) {
        const [first, second] = text.slice(3).split('.')
        return first && second ? `${first}.${second}.*.*` : 'unknown'
    }
    if (text.startsWith('v6:')) {
        const prefix = text.slice(3).replace(/::\/64$/, '')
        const [first, second] = prefix.split(':')
        return `${first || '0'}:${second || '0'}:****::/64`
    }
    return 'unknown'
}

/**
 * 取 X-Forwarded-For 里最右边一个合法地址。
 *
 * 左边那些是调用方自己可以伪造的；最右边一跳是直接对端反向代理亲眼看到的地址。
 * 只有在显式打开「信任反代」之后才走这里，默认只认 TCP 对端。
 */
export function forwardedAddress(header) {
    const raw = Array.isArray(header) ? header.join(',') : String(header ?? '')
    const parts = raw.split(',').map(part => part.trim()).filter(Boolean)
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const ip = normalizeAddress(parts[index])
        if (ip) return ip
    }
    return ''
}

/** 一次请求归到哪个地址：信任反代时优先 XFF，否则一律 TCP 对端。 */
export function clientAddress(request, { trustProxy = false } = {}) {
    if (trustProxy) {
        const forwarded = forwardedAddress(request?.headers?.['x-forwarded-for'])
        if (forwarded) return forwarded
    }
    return normalizeAddress(request?.socket?.remoteAddress || request?.connection?.remoteAddress || '')
}

export function clientKey(request, options) {
    return addressKey(clientAddress(request, options))
}

/**
 * GCRA 限流器。
 *
 * 每个桶只有一个理论到达时刻 tat：`now >= tat - 容忍量` 放行并把 tat 往后推一个间隔，
 * 否则拒绝，且天然知道下次可请求的精确时刻 `tat - 容忍量` —— 正好是 Retry-After 要的数。
 *
 * mode：
 *   enforce  超限真的拒（默认）
 *   log      照常判定、计数、记日志，但不拒 —— 调参期用
 *   off      完全不参与（不建桶、不计数）
 * 运行时可经 setMode 切换；文件轮询在 src/dispatcher.mjs，由部署者本地改文件触发。
 */
export function createRateLimiter({ ratePerSecond, burst, maxBuckets, mode } = {}) {
    const rate = parsePositiveNumber(ratePerSecond, RATE_LIMIT_DEFAULTS.ratePerSecond)
    const burstLimit = Math.max(1, Math.trunc(Number(burst) || RATE_LIMIT_DEFAULTS.burst))
    const bucketLimit = Math.max(1, Math.trunc(Number(maxBuckets) || RATE_LIMIT_DEFAULTS.maxBuckets))
    const intervalMs = 1000 / rate
    // 突发 12 的意思是「瞬时可以连打 12 次」，第 13 次起按间隔补充。
    const toleranceMs = (burstLimit - 1) * intervalMs
    const buckets = new Map()
    const totals = { allowed: 0, denied: 0, evicted: 0 }
    let currentMode = normalizeMode(mode, RATE_LIMIT_DEFAULTS.mode)

    function sweep(nowMs) {
        const now = Number(nowMs)
        if (!Number.isFinite(now)) return
        // tat <= now 等于「没有欠账」：下一次请求会从 now 重新起算，旧桶删掉不影响判定。
        for (const [key, bucket] of buckets) {
            if (now >= bucket.tat) buckets.delete(key)
        }
    }

    function makeRoom(nowMs) {
        sweep(nowMs)
        while (buckets.size >= bucketLimit) {
            const oldest = buckets.keys().next()
            if (oldest.done) return
            buckets.delete(oldest.value)
            totals.evicted += 1
        }
    }

    function check(key, nowMs) {
        if (currentMode === 'off') return { allowed: true, wouldDeny: false, retryAtMs: null, mode: currentMode }
        const now = Number(nowMs)
        if (!Number.isFinite(now)) {
            // 没有可用的「现在」就没法判定；放行比误伤一个正常请求好，计数器也不动。
            return { allowed: true, wouldDeny: false, retryAtMs: null, mode: currentMode }
        }
        let bucket = buckets.get(key)
        if (!bucket) {
            if (buckets.size >= bucketLimit) makeRoom(now)
            bucket = { tat: now, lastSeen: now, allowed: 0, denied: 0 }
            buckets.set(key, bucket)
        } else {
            // Map 的插入顺序就是 LRU 顺序：访问过的挪到队尾，桶满时挤掉队头。
            buckets.delete(key)
            buckets.set(key, bucket)
        }
        bucket.lastSeen = now

        if (now + toleranceMs >= bucket.tat) {
            bucket.tat = Math.max(bucket.tat, now) + intervalMs
            bucket.allowed += 1
            totals.allowed += 1
            return { allowed: true, wouldDeny: false, retryAtMs: null, mode: currentMode }
        }

        const retryAtMs = bucket.tat - toleranceMs
        bucket.denied += 1
        totals.denied += 1
        // log 模式不推进 tat：它模拟的是「如果现在真的拦」，两次判定必须和 enforce 一致。
        return { allowed: currentMode !== 'enforce', wouldDeny: true, retryAtMs, mode: currentMode }
    }

    function stats() {
        const top = []
        for (const [key, bucket] of buckets) {
            if (bucket.denied > 0) {
                top.push({ key, allowed: bucket.allowed, denied: bucket.denied, lastSeen: bucket.lastSeen })
            }
        }
        top.sort((left, right) => right.denied - left.denied || right.lastSeen - left.lastSeen)
        return {
            mode: currentMode,
            ratePerSecond: rate,
            burst: burstLimit,
            maxBuckets: bucketLimit,
            activeBuckets: buckets.size,
            allowed: totals.allowed,
            denied: totals.denied,
            evicted: totals.evicted,
            top: top.slice(0, 5),
        }
    }

    function setMode(next) {
        const mode = normalizeMode(next)
        if (!mode) return false
        currentMode = mode
        return true
    }

    return {
        check,
        sweep,
        stats,
        setMode,
        get mode() {
            return currentMode
        },
    }
}
