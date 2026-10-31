// 签名之外的那张 HTTP 脸：健康检查与其余路由。分发器（src/dispatcher.mjs）把非 /sign 的请求
// 全数交给这里，所以默认服务只有这一个处理器知道「签名以外还有什么端点」。
//
//   GET /livez    只回答「进程还在不在」：恒 200，不碰任何依赖，不做任何计算
//   GET /readyz   至少一台 worker 就绪、且不在关闭过程中才 200，否则 503
//   GET /healthz  /readyz 的别名 —— 已有的编排配置不改也还能用
//   /probe 与 /track/stream 只回弃用回执，不再签名也不打上游（下一版本改成 410）
//   /config 只回「已删除 + 替代做法」，不带到期头：它没有弃用期，本次就没有了
//
// 为什么要拆健康检查：探针问「你还活着吗」和「你能干活吗」是两件事。合成一个端点时，预热期
// 里的探活要么误报「活着」（其实还没法服务），要么误报「死了」（把还在起的服务判死）。
//
// 就绪判据只认 worker，不认队列饱满程度：过载时把自己从上游摘掉，剩下的实例只会更忙，
// 这是标准的死亡螺旋。过载的信号走普通请求路径的 503。
//
// 这个处理器不碰签名模块，也不向任何上游发请求。

import { maskDeviceId } from './config.mjs'
import { errorResponse } from './contract.mjs'
import { requestPathname } from './route.mjs'

/**
 * 弃用起始（本版本发布之日，RFC 9745：值是 Structured Field 的 Date，写成 `@<秒>`）与到期时刻（RFC 8594 的 HTTP-date）。
 *
 * RFC 9745 要求 `Sunset` 不早于 `Deprecation`，所以这两个常量是一对。如果「下一版本改 410」实际晚于
 * SUNSET_HTTP_DATE，发版时要把这一对一起往后推 —— 头里写着「早已到期」比不发这个头更糟。
 */
export const DEPRECATION_HTTP_VALUE = '@1793404800' // Sat, 31 Oct 2026 00:00:00 GMT
export const SUNSET_HTTP_DATE = 'Fri, 30 Apr 2027 23:59:59 GMT'

/**
 * 从 HTTP 上拿掉的端点：路由还认得，但只回答「这里没有了，改用这个」，而且回包全是常量。
 *
 * `deprecating: true` 的两条按 #1 定的节奏走：弃用期内先给「弃用 + 到期」信号并写明替代命令，
 * 下一版本才让它返回 410。`/config` 没有这一对头，因为它不是「将要移除」而是「本次就没了」——
 * 它把完整设备号与安装号明文交出去，而没有任何客户端在调用它。
 *
 * 三条都不许退成静默 404：自托管的人各自控制升级节奏，回包看不懂就等于没有过渡（#1 用户故事 24）。
 */
const REMOVED_ENDPOINTS = {
    '/probe': {
        deprecating: true,
        error: '/probe 已从 HTTP 移除：它拿调用方给的 Cookie 去请求上游，公网部署等于替别人打上游',
        replacement: 'node src/index.mjs probe --track <track_id>',
    },
    '/track/stream': {
        deprecating: true,
        error: '/track/stream 已从 HTTP 移除：整曲还是试听的判断应该在客户端做，本服务不再代取流',
        replacement:
            '客户端自己判断：用 /sign 取到签名头后请求上游，比较 video_duration 与 track.duration；' +
            '手工自检用 node src/index.mjs probe --track <track_id>',
    },
    '/config': {
        deprecating: false,
        error: '/config 已删除：它明文返回完整设备号与安装号，而没有任何客户端在调用它',
        replacement:
            '服务自己那份 device_id：不点名设备号地调 /sign，回包里就是它；' +
            '整套身份看 data/identity.json，或本机跑 node src/index.mjs config（脱敏值与来源）',
    },
}

/**
 * `readiness()` 由装配方注入（默认服务给的是「池子里有就绪 worker 且没在收尾」）。
 *
 * 没注入时按「没就绪」处理：宁可一直 503，也绝不在没人确认就绪时谎报 200 —— 编排器的起始
 * 宽限期只要看到过一次 200 就当场作废，后面预热未完的 503 再也不会保护你了。
 */
export function createEndpointsHandler({ config, readiness = () => false }) {
    return (request, response) => {
        // 只从请求行取 pathname，Host 不参与，解析永不抛（畸形目标在这里就是「没这条路由」）
        // 尾斜杠认成同一条路由：代理与手敲的 curl 常带上它，把它读成「没有这条路由」正是静默 404
        const raw = requestPathname(request)
        const pathname = raw === null ? null : raw.replace(/(?<=.)\/+$/, '')
        const send = (status, payload, headers = {}) => {
            const text = JSON.stringify(payload)
            response.writeHead(status, {
                ...headers,
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(text),
            })
            response.end(text)
        }

        if (pathname === '/livez') {
            send(200, { ok: true, service: 'libmssdk', version: config.version })
            return
        }
        if (pathname === '/readyz' || pathname === '/healthz') {
            const ready = Boolean(readiness())
            send(ready ? 200 : 503, {
                ok: ready,
                ready,
                service: 'libmssdk',
                version: config.version,
                // 只出脱敏设备号：探针是不要凭据的公开端点
                deviceId: maskDeviceId(config.deviceId),
                auth: Boolean(config.token),
                platform: process.platform,
            })
            return
        }
        // 回执放在鉴权之前，是因为它本来就属于「这条路由没有了」这一类回答：回包全是常量，
        // 没有一条服务侧数据，而今天通用的 404 也不看凭据（健康探针同理，只看方法不看凭据）。
        // 它不是免鉴权的能力入口 —— 能力（签名、打上游）都已经不在这条路上了。
        // AGENTS.md 的鉴权约定把这个边界写死在这儿。
        if (pathname !== null && Object.hasOwn(REMOVED_ENDPOINTS, pathname)) {
            const notice = REMOVED_ENDPOINTS[pathname]
            const headers = notice.deprecating ? { Deprecation: DEPRECATION_HTTP_VALUE, Sunset: SUNSET_HTTP_DATE } : {}
            send(404, {
                ok: false,
                error: notice.error,
                code: 'endpoint_removed',
                endpoint: pathname,
                replacement: notice.replacement,
                // 头读不到时的兜底：两个信号在体里各写一份，与错误契约里 Retry-After 同一规矩
                ...(notice.deprecating ? { deprecation: DEPRECATION_HTTP_VALUE, sunset: SUNSET_HTTP_DATE } : {}),
            }, headers)
            return
        }
        send(404, errorResponse('not found', 'not_found'))
    }
}
