// 默认服务的装配：/sign 走分发器（主进程监听 + worker 计算），签名以外的端点由 src/endpoints.mjs
// 承接 —— 健康检查、诊断状态、旧诊断端点的弃用回执、其余 404 都在那一个处理器里。
//
// 落在这一层的三件事：
//   1. /readyz 的答案 = 「池子里有就绪 worker」且「没在收尾」。预热没完成或已经开始收尾时谎报
//      200，编排器的起始宽限期当场作废，跟着被放进来流量的第一个用户拿到的是 503。
//   2. 主进程那份 signer 不进 HTTP 层：签名只经 worker 算，端点处理器不需要它。
//   3. 这里也是限流与诊断状态的装配点：/sign 的 429 由分发器问同一个限流器，/stat 读的队列深度、
//      worker 数与桶计数来自同一份装配。没有监控系统时，部署者靠 /stat 判断出了什么事。
//
// 收尾的顺序由 index.mjs 保证：先 markClosing()（让 /readyz 改口），再停监听、等在飞与排队的
// 请求收完，最后收 worker —— 反过来会把排队中的请求直接掐掉。

import { maskAddressKey } from './ratelimit.mjs'
import { createEndpointsHandler } from './endpoints.mjs'
import { startDispatcher } from './dispatcher.mjs'

/**
 * worker 读身份的两条路：环境变量钉死，或只读身份文件。
 *
 * 身份只在内存里（state 目录不可写，identityPersisted=false）时两条路都没有值，worker 会
 * 误报 SIGNER_UNAVAILABLE。主进程这时把已经解析好的设备号经环境变量交给 worker —— 仍然没有
 * 第二个写入口，只是把「读到的那份」传下去。
 */
export function workerEnvFor(config, env) {
    if (config?.identityPersisted !== false || !config?.deviceId) return env
    return { ...env, LIBMSSDK_DEVICE_ID: config.deviceId }
}

/**
 * /stat 的回包：活跃桶数、允许/拒绝计数、队列深度、当前 worker 数。
 *
 * 限流桶的键在这里换成脱敏地址 —— 原始键包含完整 IP，不能出现在诊断输出里。
 * /stat 自己不过限流器，也不打访问日志（见 src/endpoints.mjs）。
 *
 * `trustProxy` 也在这里：#9 删掉了那个明文返回整套设备身份的 /config，而「部署者能不能在运行时
 * 核对这个开关」是 #8 提的要求。开关不是秘密，但它原先只在启动日志里写过一次；重启前想核对，
 * 诊断端点就是那个地方。
 */
export function statResponse({ config, pool, limiter, diagnostics }) {
    const { top, ...rate } = limiter.stats()
    return {
        ok: true,
        service: 'libmssdk',
        version: config.version,
        queue: { depth: diagnostics.queueDepth(), limit: diagnostics.queueLimit },
        workers: { total: pool.size, ready: pool.readyCount, busy: pool.busyCount },
        rateLimit: {
            ...rate,
            trustProxy: Boolean(config.trustProxy),
            top: top.map(entry => ({
                address: maskAddressKey(entry.key),
                allowed: entry.allowed,
                denied: entry.denied,
            })),
        },
    }
}

export function startServe({ config, env = process.env, ...options } = {}) {
    // 令牌检查在 startDispatcher 的最前面（fork 之前）：这里只做默认服务的装配。
    const state = { closing: false }
    const started = startDispatcher({
        config,
        ...options,
        env: workerEnvFor(config, env),
        createFallback: ({ pool, limiter, diagnostics }) =>
            createEndpointsHandler({
                config,
                readiness: () => !state.closing && pool.readyCount > 0,
                stats: () => statResponse({ config, pool, limiter, diagnostics }),
            }),
    })
    // 交回给信号处理用：SIGTERM 到达的第一件事就是说「我不再接流量了」，
    // 而不是等 server.close() 之后才改口 —— 那时排队的请求已经在往里挤了。
    return { ...started, markClosing: () => { state.closing = true } }
}
