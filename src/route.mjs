// 路由解析：只从请求行里取 pathname，分发器（/sign）与签名之外的端点处理器共用这一份。
//
// 两条规矩：
//   1. base 写死，不拿 Host 头去拼 —— 那是调用方随手能写的内容，服务端不该让它参与解析。
//   2. 解析失败不能抛。handler 是 async，抛出去就是 unhandled rejection：Node 15+ 默认
//      直接退进程，一条匿名请求就能把整个服务掀掉。而畸形请求目标是送得到的 ——
//      `GET // HTTP/1.1` 会被 llhttp 收下，而 `new URL('//', base)` 抛 TypeError。
//      所以这里返回 null，由调用方当成「没有这条路由」（回 404 / 400），连接本身保持健康。
const BASE = 'http://127.0.0.1'

/** 拿不到 pathname 就返回 null（请求目标畸形）。永不抛。 */
export function requestPathname(request) {
    try {
        return new URL(request.url || '/', BASE).pathname
    } catch {
        return null
    }
}
