// 默认服务的装配：/sign 走分发器（主进程监听 + worker 计算），其余端点暂时由老处理器承接。
//
// 为什么还留着老处理器：Docker 健康检查与 verify/wine-multi 都依赖 /healthz 和 /config，
// 而「收拢诊断端点、拆分健康检查」是 #9 的活。这一票只翻转 /sign 的行为，过渡端点保持可用，
// 但 /healthz 的 200 必须跟「至少一台 worker 就绪」绑定 —— 预热未完成就回 200，编排器会
// 立刻把流量放进来，第一个用户拿到的是 503。
//
// #8 起这里还是限流与诊断状态的装配点：/sign 的 429 由分发器问同一个限流器，/stat 读的
// 队列深度、worker 数与桶计数也来自同一份装配。没有监控系统时，部署者靠 /stat 判断出了什么事。
//
// /probe 与 /track/stream 过渡期仍在主进程里同步签名。它们都会短暂阻塞事件循环，这是
// 端点收拢（#9）之前已知的例外；#9 把 /probe 收成命令行子命令并删除 /track/stream 之后，
// HTTP 层就不再有任何主进程同步签名的路径。

import { maskAddressKey } from './ratelimit.mjs'
import { createLegacyHandler } from './server.mjs'
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
 * /stat 自己不过限流器，也不打访问日志（见 src/server.mjs）。
 */
export function statResponse({ config, pool, limiter, diagnostics }) {
    const { top, ...rate } = limiter.stats()
    const busy = typeof pool.busyCount === 'function' ? pool.busyCount() : Number(pool.busyCount) || 0
    return {
        ok: true,
        service: 'libmssdk',
        version: config.version,
        queue: { depth: diagnostics.queueDepth(), limit: diagnostics.queueLimit },
        workers: { total: pool.size, ready: pool.readyCount, busy },
        rateLimit: {
            ...rate,
            top: top.map(entry => ({
                address: maskAddressKey(entry.key),
                allowed: entry.allowed,
                denied: entry.denied,
            })),
        },
    }
}

export function startServe({ config, signer, env = process.env, ...options } = {}) {
    // 令牌检查在 startDispatcher 的最前面（fork 之前）：这里只做默认服务的装配。
    return startDispatcher({
        config,
        ...options,
        env: workerEnvFor(config, env),
        createFallback: ({ pool, limiter, diagnostics }) =>
            createLegacyHandler({
                config,
                signer,
                readiness: () => pool.readyCount > 0,
                rateLimiter: limiter,
                stats: () => statResponse({ config, pool, limiter, diagnostics }),
            }),
    })
}
