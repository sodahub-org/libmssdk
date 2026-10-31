// 默认服务的装配：/sign 走分发器（主进程监听 + worker 计算），签名以外的端点由 src/endpoints.mjs
// 承接 —— 健康检查、旧诊断端点的弃用回执、其余 404 都在那一个处理器里。
//
// 落在这一层的两件事：
//   1. /readyz 的答案 = 「池子里有就绪 worker」且「没在收尾」。预热没完成或已经开始收尾时谎报
//      200，编排器的起始宽限期当场作废，跟着被放进来流量的第一个用户拿到的是 503。
//   2. 主进程那份 signer 不进 HTTP 层：签名只经 worker 算，端点处理器不需要它。
//
// 收尾的顺序由 index.mjs 保证：先 markClosing()（让 /readyz 改口），再停监听、等在飞与排队的
// 请求收完，最后收 worker —— 反过来会把排队中的请求直接掐掉。

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

export function startServe({ config, env = process.env, ...options } = {}) {
    const state = { closing: false }
    const started = startDispatcher({
        config,
        ...options,
        env: workerEnvFor(config, env),
        createFallback: pool =>
            createEndpointsHandler({
                config,
                readiness: () => !state.closing && pool.readyCount > 0,
            }),
    })
    // 交回给信号处理用：SIGTERM 到达的第一件事就是说「我不再接流量了」，
    // 而不是等 server.close() 之后才改口 —— 那时排队的请求已经在往里挤了。
    return { ...started, markClosing: () => { state.closing = true } }
}
