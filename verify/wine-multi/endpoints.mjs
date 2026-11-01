// 两个控制面共用的观察工具：/readyz 探活、就绪等待、日志取尾。
// 只返回状态与失败形态，不返回响应体内容。
//
// 探的是就绪端点而不是 /livez：这里要的「就绪」是「能干活」（worker 预热完了），
// 恒 200 的 /livez 只回答「进程还在不在」，拿它等就绪会等到一个假信号。

const readyUrl = port => `http://127.0.0.1:${port}/readyz`

/**
 * 单一探活原语，四种结果都要分清：
 * 'ready' 应答且 2xx / 'http' 应答但非 2xx / 'refused' 连不上 / 'hung' 接了但不答话。
 * 'hung' 与 'refused' 混为一谈会把「卡死」读成「干净退出」，而卡死正是共享 prefix 被拖垮的样子。
 */
export async function probeReady(port, probeTimeoutMs = 4000) {
    try {
        const response = await fetch(readyUrl(port), { signal: AbortSignal.timeout(probeTimeoutMs) })
        return response.status === 200 ? 'ready' : 'http'
    } catch (error) {
        return error?.name === 'TimeoutError' ? 'hung' : 'refused'
    }
}

export async function fetchReady(port, probeTimeoutMs = 4000) {
    if ((await probeReady(port, probeTimeoutMs)) !== 'ready') return null
    try {
        const response = await fetch(readyUrl(port), { signal: AbortSignal.timeout(probeTimeoutMs) })
        return await response.json()
    } catch {
        return null
    }
}

/**
 * 停止期间观察用：要分辨的是「可读的 503」与「连接被拒」，所以这里把状态码原样带回来
 * （probeReady 把所有非 2xx 折叠成 'http'，够判活不够判形态）。
 * 返回 { kind: 'http', status } 或 { kind: 'refused' | 'hung' }。
 */
export async function probeStatus(port, probeTimeoutMs = 800) {
    try {
        const response = await fetch(readyUrl(port), { signal: AbortSignal.timeout(probeTimeoutMs) })
        return { kind: 'http', status: response.status }
    } catch (error) {
        return { kind: error?.name === 'TimeoutError' ? 'hung' : 'refused' }
    }
}

/**
 * 一个进程自己的身份视图：不点名设备号的 /sign，回包里的 device_id 就是该进程自己解析出来的那一份。
 *
 * URL、headers 与请求体里都不许出现设备号 —— 带了就变成比对我们自己发过去的那个值，身份真分裂了
 * 也照样「一致」，是循环论证。#9 删掉了明文返回整套身份的 /config（完整设备号直接给出去，而没有任何
 * 客户端在调它），这条是它的替代；两个控制面共用，别各写一份。
 */
export async function fetchOwnIdentity(port, timeoutMs) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/sign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088',
                method: 'POST',
                headers: { 'user-agent': 'LunaPC/verify' },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) return null
        const payload = await response.json()
        return payload?.device_id ? { deviceId: String(payload.device_id) } : null
    } catch {
        return null
    }
}

/** 返回仍未就绪的进程：seenKinds 只记真的观察到过的形态，lastErrorKind 是最后一次的结果。
 *  用 Set 的插入顺序当「最后一次」是错的：refused→hung→refused 会让 at(-1) 回 hung。 */
export async function waitForReady(ports, { timeoutMs, intervalMs, probeTimeoutMs }) {
    const deadline = Date.now() + timeoutMs
    const pending = new Map(ports.map((_, index) => [index, { seen: new Set(), last: 'refused' }]))
    while (pending.size && Date.now() < deadline) {
        for (const [index, state] of pending) {
            const kind = await probeReady(ports[index], probeTimeoutMs)
            if (kind === 'ready') pending.delete(index)
            else {
                state.seen.add(kind)
                state.last = kind
            }
        }
        if (pending.size) await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
    return [...pending.entries()].map(([index, state]) => ({
        index,
        lastErrorKind: state.last,
        seenKinds: state.seen.size ? [...state.seen] : [state.last],
    }))
}

export function tailLines(text, count = 8) {
    return String(text || '').split('\n').filter(Boolean).slice(-count)
}
