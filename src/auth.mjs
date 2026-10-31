// 鉴权：一次 Bearer Token 比对。
//
// 抽出来是因为鉴权判据只该有一份 —— 计时安全比较这种东西不该各写一遍。
// 默认规则仍是「没配令牌就全开放」，那是 #8 要改的（绑定非回环又没配令牌应该拒绝启动），
// 这一票不动对外行为。
import crypto from 'node:crypto'

function timingSafeEqual(a, b) {
    const left = Buffer.from(String(a))
    const right = Buffer.from(String(b))
    if (left.length !== right.length) return false
    return crypto.timingSafeEqual(left, right)
}

export function isAuthorized(request, config) {
    // 没配令牌时恒为放行：本机自用的默认形态就是这样，要不要强制配 Token 不由这里判。
    // #8 才收这条：绑定回环且没配令牌才放行，绑定非回环且没配令牌则拒绝启动。
    if (!config.token) return true
    const header = request.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return token.length > 0 && timingSafeEqual(token, config.token)
}
