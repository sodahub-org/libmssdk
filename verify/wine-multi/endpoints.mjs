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
