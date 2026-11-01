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
// 收尾的顺序由这里的 shutdownGracefully 保证：先 markClosing()（让 /readyz 改口），
// 按需留一个排空窗口让编排器读到 503，再停监听、等在飞与排队的请求收完，最后收 worker ——
// 反过来会把排队中的请求直接掐掉。

import { maskAddressKey } from './ratelimit.mjs'
import { createEndpointsHandler } from './endpoints.mjs'
import { startDispatcher } from './dispatcher.mjs'
import { logError, redactMachinePaths } from './log.mjs'

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

/**
 * 排空窗口：markClosing() 之后、server.close() 之前保持监听的那段时间。
 *
 * 为什么需要它：改口与停监听如果发生在同一刻，探针与调用方根本读不到那个 503 ——
 * 新连接在「已经改口」之后仍会撞上连接被拒。窗口只推迟「关监听」的时刻，不推迟改口：
 * 0（默认）就是原先的行为，容器形态在 compose 里显式给一个几秒的值。
 *
 * 这里再收一遍口：config 可能来自 loadConfig（已归一化），也可能是测试/嵌入方直接给的
 * 普通对象 —— 收尾计时不该因为一个 NaN 或负数把窗口算错（NaN 在比较里会被当成 0）。
 */
export function resolveDrainDelay(config) {
    const value = Math.trunc(Number(config?.drainDelayMs))
    return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 收尾时收池子：失败只记一笔，绝不挂住收尾。
 *
 * 先包一层再调 —— 注入的 pool.stop 若同步抛，直接调会让异常从 server.close 的回调里逸出、
 * resolve 永不执行；reject 则是一条无人处理的 rejection。错误文本按本机路径脱敏，
 * 与 src/index.mjs 端口错误路径共用这一份形状。
 */
export function stopPoolQuietly(pool, locations = []) {
    return Promise.resolve()
        .then(() => pool.stop())
        .catch(error => logError(`pool.stop: ${redactMachinePaths(String(error?.message || error), locations)}`))
}

/**
 * 收尾序列的唯一实现：先改口，再按需留排空窗口，然后停监听、等在飞与排队请求收完、最后收 worker。
 *
 * 顺序不能反：先 server.close() 会把排队中的请求直接掐掉，而且 /readyz 也再没人问得到。
 * 只经 startServe 暴露（beginShutdown），不单独导出：调用方不该绕过装配自己拼顺序。
 */
function shutdownGracefully({ server, pool, markClosing, drainDelayMs = 0, locations = [] }) {
    markClosing()
    const stopListening = () =>
        new Promise(resolve => {
            server.close(() => {
                // pool.stop() 只发 shutdown 消息、不等待线程退出；等它返回再解析，
                // 让调用方（index.mjs 的退出 / 用例的断言）看到的是「序列已经走完」。
                stopPoolQuietly(pool, locations).finally(resolve)
            })
            server.closeIdleConnections?.()
        })
    if (drainDelayMs > 0) {
        return new Promise(resolve => {
            setTimeout(() => {
                stopListening().finally(resolve)
            }, drainDelayMs)
        })
    }
    return stopListening()
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
    const markClosing = () => {
        state.closing = true
    }
    const drainDelayMs = resolveDrainDelay(config)
    // 交回给信号处理用：SIGTERM 到达的第一件事就是说「我不再接流量了」，
    // 而不是等 server.close() 之后才改口 —— 那时排队的请求已经在往里挤了。
    return {
        ...started,
        markClosing,
        drainDelayMs,
        beginShutdown: () =>
            shutdownGracefully({
                server: started.server,
                pool: started.pool,
                markClosing,
                drainDelayMs,
                locations: [config.bdmsModule, config.clientDir],
            }),
    }
}
