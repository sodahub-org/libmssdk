// 鉴权：一次 Bearer Token 比对，以及 serve 启动前的「没令牌能不能开门」检查。
//
// 抽出来只因为分发器和老路径要用同一份判据 —— 计时安全比较这种东西不该有两份各写一遍。
//
// 没配令牌时的规则（#8 起）：只有绑定回环地址才放行（本机自用）；绑定非回环地址一律拒绝启动，
// 而不是静默敞开。命令行的 bridge / selftest / probe 不经过这里，它们本来就不监听。
import crypto from 'node:crypto'
import net from 'node:net'

function timingSafeEqual(a, b) {
    const left = Buffer.from(String(a))
    const right = Buffer.from(String(b))
    if (left.length !== right.length) return false
    return crypto.timingSafeEqual(left, right)
}

export function isAuthorized(request, config) {
    // 没配令牌时恒为放行：能走到这里的前提是 serveAuthError() 已经确认绑定的是回环地址。
    if (!config.token) return true
    const header = request.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return token.length > 0 && timingSafeEqual(token, config.token)
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1', '[::1]'])

/** 绑定地址是不是只有本机能连上。空地址在 Node 里等于监听所有网卡，所以不算回环。 */
export function isLoopbackBind(host) {
    const value = String(host || '').trim().toLowerCase()
    if (!value) return false
    if (LOOPBACK_HOSTS.has(value)) return true
    return net.isIPv4(value) && value.startsWith('127.')
}

/**
 * 非回环 + 没有令牌 = 拒绝启动，返回给人看的原因；配置没问题返回 null。
 *
 * 令牌等于签名能力，对所有人开放等于把自己的出口 IP 和设备画像押上去。这个检查放在
 * src/serve.mjs 装配之前：别先 fork 一堆 worker 再退出。
 */
export function serveAuthError(config = {}) {
    if (config.token) return null
    if (isLoopbackBind(config.host)) return null
    const bind = String(config.host || '').trim() || '(未设置，Node 会监听所有网卡)'
    return `绑定地址 ${bind} 不是回环地址，但没有设置 LIBMSSDK_TOKEN：拒绝启动。请设置 LIBMSSDK_TOKEN，或改为绑定 127.0.0.1。`
}

export function assertServeAuth(config = {}) {
    const message = serveAuthError(config)
    if (message) throw new Error(message)
}
