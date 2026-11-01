// 鉴权：一次 Bearer Token 比对，以及 serve 启动前的「没令牌能不能开门」检查。
//
// 抽出来是因为鉴权判据只该有一份 —— 计时安全比较这种东西不该各写一遍。#9 之后只有分发器
// 调它（签名之外的端点里，探针与回执不看凭据，见 src/endpoints.mjs）。
//
// 没配令牌时的规则（#8 起）：只有绑定回环地址才放行（本机自用）；绑定非回环地址一律拒绝启动，
// 而不是静默敞开。命令行的 bridge / selftest / probe 不经过这里，它们本来就不监听。
import crypto from 'node:crypto'
import { isLoopbackBind } from './dispatch.mjs'

function timingSafeEqual(a, b) {
    const left = Buffer.from(String(a))
    const right = Buffer.from(String(b))
    if (left.length !== right.length) return false
    return crypto.timingSafeEqual(left, right)
}

export function isAuthorized(request, config) {
    // 没配令牌时恒为放行：默认服务的启动检查（assertServeAuth）已经确认绑定的是回环地址；
    // 直接构造 createDispatcher 的嵌入用法也会在构造时过同一道检查。
    if (!config.token) return true
    const header = request.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return token.length > 0 && timingSafeEqual(token, config.token)
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
