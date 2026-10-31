// 分发器：主进程独占监听、解析 HTTP、持有队列与等待预算；计算全部交给 worker。
//
// 为什么要拆开：一次签名要阻塞一百到几百毫秒并吃满一个核，期间那个进程什么都做不了 ——
// 包括「读自己的时钟」。拆开之后主进程的事件循环一直是空的，它才可能计时、才可能在超出
// 等待预算时回那个 503。
//
// 默认路径（#7 起）：src/serve.mjs 把 /sign 交给这里，其余端点由过渡处理器承接。
//
// 不传 socket 句柄：Node 现行文档写明不支持在 Windows 上发送 IPC socket，Windows 上逐连接
// 句柄分发的问题多年未修。这里转的是请求（上限沿用 256 KB）与响应（约 1 KB）的字节。
//
// 等待预算与队列上限只从 config 来：同一数字有两个来源（参数 + 环境变量）迟早会对不上。
//
// #8 起这里还负责按客户端地址限流：鉴权之后、读请求体之前问一次限流器（429 与 BUSY 是
// 两件事，前者是调用方打得太快，后者是服务容量不够）。限流器本身在 src/ratelimit.mjs，
// 这里只做「拿当前时间调纯函数」和写出。运行时模式开关轮询一个控制文件（同样只读时钟）。

import http from 'node:http'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAuthorized } from './auth.mjs'
import { maskDeviceId } from './config.mjs'
import { errorResponse, normalizeSignRequest, ValidationError } from './contract.mjs'
import { GIVE_UP_WINDOW_MS, Queue, deriveWorkerCount, parsePositiveInt, shouldReject } from './dispatch.mjs'
import { ERROR_KINDS, failureResponse, retryAfterFromInstant } from './errors.mjs'
import { logEvent, redactMachinePaths } from './log.mjs'
import { createRateLimiter, clientKey, maskAddressKey, normalizeMode, rateLimitSettingsFromEnv } from './ratelimit.mjs'
import { requestPathname } from './route.mjs'
import { createWorkerPool } from './workerpool.mjs'

/** 客户端超时约 6 秒，留余量：预算是「还在服务里等」的时间，不包含它自己那头的网络时间。 */
const DEFAULT_WAIT_BUDGET_MS = 5000

/** 全局队列上限：worker 数的几倍。超过就当场拒，而不是堆到大家一起超时。 */
const QUEUE_LIMIT_PER_WORKER = 4

/** 503 写完之后的宽限：让字节先出去，别让客户端在上传中途读到连接重置。 */
const CLOSE_GRACE_MS = 300

/** 与 loadConfig 的默认值一致；配置给得不像话时退回它，而不是退回「无限」。 */
const DEFAULT_MAX_BODY_BYTES = 256 * 1024

/** 体太长：除了「改请求」，还要在回包之后把这条连接关掉（已经收不完的字节了）。 */
class OversizeBody extends ValidationError {}

function readBody(request, limit) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        request.on('data', chunk => {
            size += chunk.length
            if (size > limit) {
                // 不 destroy：客户端要读得到那句 400，而不是在上传中途拿到一个连接重置 ——
                // 和超预算那个 503 同一个道理。剩下的字节继续从管道排掉，只是不再缓冲。
                reject(new OversizeBody(`请求体超过 ${limit} 字节`))
                request.resume()
                return
            }
            chunks.push(chunk)
        })
        request.on('end', () => resolve(Buffer.concat(chunks)))
        request.on('error', reject)
    })
}


/** 只留请求形状：路径、方法、头数量、体字节数、脱敏设备号。Cookie 与签名值一律不落盘。 */
function requestShape(spec, config) {
    return {
        path: String(spec.url).split('?')[0],
        method: spec.method,
        headers: Object.keys(spec.headers).length,
        bodyBytes: Buffer.byteLength(spec.body || ''),
        deviceId: maskDeviceId(spec.deviceId || config.deviceId),
    }
}

/**
 * 预拼好的 503：状态码、头、体在启动时就算完，热路径上不再 JSON.stringify。
 *
 * 拒绝发生在最忙的那一刻，所以这里能不干活就一点都不干。等待时长由 #4 的分类表说了算。
 */
function prebuildBusy() {
    const failure = failureResponse(ERROR_KINDS.BUSY, { message: '服务忙：没有空闲的签名槽位' })
    const body = Buffer.from(JSON.stringify(failure.body))
    return {
        status: failure.status,
        headers: {
            ...failure.headers,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': String(body.byteLength),
            Connection: 'close',
        },
        body,
    }
}

export function createDispatcher({
    config,
    pool,
    log = logEvent,
    fallback = null,
    limiter = null,
    modeFile = '',
    modePollMs = 2000,
    diagnostics = null,
} = {}) {
    const waitBudgetMs = parsePositiveInt(config.waitBudgetMs, DEFAULT_WAIT_BUDGET_MS)
    const queueLimit = parsePositiveInt(config.queueLimit, pool.size * QUEUE_LIMIT_PER_WORKER)
    // 只信 config 给的数：一个手抖写成 abc 的 LIBMSSDK_MAX_BODY_BYTES 会让 size > limit
    // 永远不成立，于是每个请求体都被无上限缓冲进内存
    const maxBodyBytes = parsePositiveInt(config.maxBodyBytes, DEFAULT_MAX_BODY_BYTES)
    const queue = new Queue(queueLimit)
    const busy503 = prebuildBusy()
    // /stat 由过渡处理器承接，但它要读分发器自己的队列深度：装配期把这个口子交出去，
    // 而不是让两边各存一份会漂移的数字。
    if (diagnostics) {
        diagnostics.queueDepth = () => queue.depth
        diagnostics.queueLimit = queueLimit
    }

    /**
     * 每条连接一个 item，close 监听挂在**返回的那个对象**上。
     *
     * 调用方要往返回值上继续加字段（request / startedAt），不能把展开后的副本丢掉再挂一次 ——
     * 那样 closed 永远翻转不到被排队、被派发的那份，写出路径就会往已经断开的连接上写，
     * 而它占着的那个排队位置也永远还不回来。
     */
    function begin(response, shape) {
        const item = { response, shape, enqueuedAt: 0, closed: false }
        response.on('close', () => {
            item.closed = true
            queue.remove(item)
        })
        return item
    }

    /** 写完让字节先出去，再隔一小段才关：直接销毁会让客户端读到连接重置而不是这个回包。 */
    function endAfterFlush(response) {
        const socket = response.socket
        if (socket && !socket.destroyed) {
            socket.setTimeout(CLOSE_GRACE_MS, () => socket.end())
        }
    }

    function writeBusy(item, reason) {
        if (item.closed) return
        log('busy', {
            ...item.shape,
            reason,
            queuedMs: item.enqueuedAt ? Date.now() - item.enqueuedAt : 0,
            depth: queue.depth,
            readyWorkers: pool.readyCount,
            waitBudgetMs,
        })
        const response = item.response
        response.writeHead(busy503.status, busy503.headers)
        response.end(busy503.body)
        endAfterFlush(response)
    }

    /** `close` 用在「这条连接的请求体都读不完」那种情况：留着 keep-alive 只会把框架搞乱。 */
    function writeFailure(item, failure, { close = false, event = 'sign-failed', detail = {} } = {}) {
        if (item.closed) return
        log(event, { ...item.shape, code: failure.body.code, reason: failure.body.error, ...detail })
        const body = JSON.stringify(failure.body)
        item.response.writeHead(failure.status, {
            ...failure.headers,
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            ...(close ? { Connection: 'close' } : {}),
        })
        item.response.end(body)
        if (close) endAfterFlush(item.response)
    }

    function writeResult(item, slot, outcome) {
        if (item.closed) return
        // queuedMs 是「在队列里躺着」的那一段，不含 worker 自己算的时间
        const queuedMs = item.enqueuedAt && item.leasedAt ? item.leasedAt - item.enqueuedAt : 0
        log('sign', {
            ...item.shape,
            worker: slot.id,
            elapsedMs: Date.now() - item.startedAt,
            queuedMs,
        })
        const body = JSON.stringify(outcome.body)
        item.response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
        })
        item.response.end(body)
    }

    /** 派发给一台 worker。槽位在 worker 报告完成之前不回池，所以这里不留「超时重试」。 */
    function assign(item, slot) {
        item.leasedAt = Date.now()
        slot.run(item.request).then(
            outcome => {
                if (outcome?.kind === ERROR_KINDS.SUCCESS) {
                    writeResult(item, slot, outcome)
                    return
                }
                writeFailure(
                    item,
                    failureResponse(outcome?.kind || ERROR_KINDS.INTERNAL_ERROR, {
                        message: outcome?.message || '签名失败',
                    }),
                )
            },
            error => {
                writeFailure(
                    item,
                    failureResponse(error?.kind || ERROR_KINDS.INTERNAL_ERROR, {
                        message: '签名进程在处理途中退出',
                    }),
                )
            },
        )
    }

    /**
     * 鉴权之后、读体之前问一次限流器。
     *
     * 429 与 503 的区别在这里：429 是「这个地址打得太快」，与 worker 忙不忙无关，所以它先于
     * 队列判断。log 模式下把「本来会被拒」的请求放过去，但仍然记一条带脱敏地址的日志 ——
     * 否则调参期开了开关什么都看不到。
     */
    function admit(request, item) {
        if (!limiter) return true
        const now = Date.now()
        const key = clientKey(request, { trustProxy: config.trustProxy })
        const decision = limiter.check(key, now)
        if (!decision.wouldDeny) return true

        const ip = maskAddressKey(key)
        const retryAfterSeconds = retryAfterFromInstant(decision.retryAtMs, now)
        if (decision.allowed) {
            log('rate-limited', { ...item.shape, ip, mode: decision.mode, retryAfterSeconds })
            return true
        }
        const failure = failureResponse(ERROR_KINDS.RATE_LIMITED, {
            message: '请求过于频繁：这个地址的额度已用完',
            retryAtMs: decision.retryAtMs,
            nowMs: now,
        })
        // 请求体还没读：先把剩余字节排掉再关连接，客户端才读得到这个 429 而不是连接重置。
        request.resume()
        writeFailure(item, failure, {
            close: true,
            event: 'rate-limited',
            detail: { ip, mode: decision.mode, retryAfterSeconds: failure.body.retry_after_seconds },
        })
        return false
    }

    /**
     * 有槽位空出来就清队列：先进先出，队头超预算之前它一直是队头。
     *
     * 挂断的连接由 begin() 里的 close 监听当场从队列摘走，所以这里不需要再认一遍连接状态：
     * 实测响应自己的 'close' 总是先于任何能观察到的 response.destroyed 落地，多写一个分支
     * 只会留下一条没人走到的代码。
     */
    function drain() {
        while (queue.depth > 0) {
            const item = queue.peek()
            const slot = pool.lease()
            if (!slot) return
            queue.shift()
            assign(item, slot)
        }
    }

    /** 定时器只做一件事：拿当前时刻去问那个纯函数，然后照答案执行。判断本身不在这里。 */
    function expireQueue() {
        const now = Date.now()
        for (;;) {
            const item = queue.peek()
            if (!item) return
            if (!shouldReject(item.enqueuedAt, now, waitBudgetMs)) return
            queue.shift()
            writeBusy(item, '超出等待预算')
        }
    }

    pool.on('available', drain)

    const server = http.createServer(async (request, response) => {
        const startedAt = Date.now()
        // 只取 pathname，且解析本身永不抛：这条 handler 是 async，抛出去就是 unhandled
        // rejection，而一条匿名请求（`POST // HTTP/1.1`）就够触发。畸形目标按「没这条路由」处理。
        const pathname = requestPathname(request)
        try {
            // 分发器只做签名这一件事。默认服务给非 /sign 路由注入过渡处理器（健康检查、
            // 诊断端点），等 #9 收拢；直接建分发器的用例不注入时仍保持老的 404 形状。
            if (request.method !== 'POST' || pathname !== '/sign') {
                if (fallback) {
                    await fallback(request, response)
                    return
                }
                const body = JSON.stringify(errorResponse('not found', 'not_found'))
                response.writeHead(404, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': Buffer.byteLength(body),
                })
                response.end(body)
                return
            }
            const item = begin(response, { path: pathname, method: request.method })
            if (!isAuthorized(request, config)) {
                writeFailure(item, failureResponse(ERROR_KINDS.UNAUTHORIZED, { message: '缺少或错误的 Bearer Token' }))
                return
            }
            if (!admit(request, item)) return

            let spec
            try {
                const text = (await readBody(request, maxBodyBytes)).toString('utf8')
                spec = normalizeSignRequest(JSON.parse(text || '{}'))
            } catch (error) {
                // 非法 JSON、缺 url、体太长 —— 都是「改请求，别重试」
                writeFailure(
                    item,
                    failureResponse(ERROR_KINDS.INVALID_REQUEST, {
                        message: error instanceof ValidationError ? error.message : '请求体不是合法 JSON',
                    }),
                    { close: error instanceof OversizeBody },
                )
                return
            }

            // 形状等解析完才有设备号与体长；限流日志在解析之前，只记路径与方法。
            item.shape = requestShape(spec, config)
            item.request = spec
            item.startedAt = startedAt

            if (pool.blocker) {
                writeFailure(item, failureResponse(pool.blocker, { message: '签名模块没加载或配置错（含设备身份缺失）' }))
                return
            }
            if (pool.readyCount === 0) {
                // 一台都不就绪 = 整体拒绝流量：排队也排不到东西去做
                writeBusy(item, '没有就绪的 worker')
                return
            }
            const slot = pool.lease()
            if (slot) {
                assign(item, slot)
                return
            }
            item.enqueuedAt = Date.now()
            if (!queue.push(item)) {
                writeBusy(item, '队列已满')
                return
            }
        } catch (error) {
            log('dispatcher-error', {
                message: redactMachinePaths(String(error?.message || error), [config.bdmsModule, config.clientDir]),
                path: pathname,
            })
            if (!response.headersSent && !response.writableEnded) {
                response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
                response.end(JSON.stringify(failureResponse(ERROR_KINDS.INTERNAL_ERROR, { message: '内部错误' }).body))
            }
        }
    })

    // 扫描间隔跟着预算走：预算 50ms 的用例不该等一个 100ms 的节拍才看到超时。
    const sweepMs = Math.max(10, Math.min(100, Math.floor(waitBudgetMs / 4)))
    const sweeper = setInterval(expireQueue, sweepMs)
    sweeper.unref()

    // 运行时模式开关：部署者在 state 目录里改写 rate-limit.mode（enforce / log / off），
    // 这里每 pollMs 读一次；每个请求都不碰文件。顺带回收过期桶，内存不随运行时长上涨。
    let housekeeping = null
    if (limiter) {
        let lastInvalid = null
        const applyModeFromFile = () => {
            if (!modeFile) return
            let raw
            try {
                raw = fs.readFileSync(modeFile, 'utf8')
            } catch {
                return // 没有控制文件：保持启动时的模式
            }
            const next = normalizeMode(raw)
            if (!next) {
                // 写到一半的控制文件（例如重定向还没落完）按「这次没写」处理；同一份坏内容只报一次。
                if (raw !== lastInvalid) {
                    lastInvalid = raw
                    log('rate-limit-mode-invalid', { mode: limiter.mode })
                }
                return
            }
            lastInvalid = null
            if (next !== limiter.mode) {
                limiter.setMode(next)
                log('rate-limit-mode', { mode: next, source: 'file' })
            }
        }
        // 启动时先认一次文件：重启之后不该等下一个节拍才回到部署者设定的模式。
        applyModeFromFile()
        housekeeping = setInterval(() => {
            limiter.sweep(Date.now())
            applyModeFromFile()
        }, Math.max(100, modePollMs))
        housekeeping.unref()
    }

    server.on('close', () => {
        clearInterval(sweeper)
        if (housekeeping) clearInterval(housekeeping)
    })

    return server
}

const WORKER_PATH = fileURLToPath(new URL('./worker.mjs', import.meta.url))

/** 真的拉一个 worker 进程。stdio 用继承：worker 自己的日志要落到容器日志里，不用再搭管道。 */
export function forkWorker(index, env = process.env) {
    return fork(WORKER_PATH, [], { env })
}

/**
 * 组装生产形态的分发器：算出 worker 数、把来由打进日志、建池子、建服务。
 *
 * 默认服务（src/serve.mjs）通过 `createFallback({ pool, limiter, diagnostics })` 注入过渡端点
 * 处理器；它需要拿到池子，好让 /healthz 反映「至少一台 worker 就绪」—— 预热期间回 200 会让
 * 编排器的起始宽限期作废；也需要限流器与队列深度，好让 /stat 与 /sign 看到同一份状态。
 *
 * 端口先开、worker 在后台一台一台预热：预热期间客户端要读到的是那个 503（带 Retry-After），
 * 而不是「没人听这个端口」。反过来说，把 listen 等到所有 worker 预热完，最坏情况是
 * workerCount × 30 秒的拒接窗口，编排器的起始宽限期就是这么被吃掉的。
 * 预热一台都没起来时，分发器按「整体拒绝流量」回 503；配置错由 blocker 报成 500。
 */
export function startDispatcher({
    config,
    env = process.env,
    log = logEvent,
    spawn = forkWorker,
    onGiveUp = () => process.exit(1),
    createFallback = null,
} = {}) {
    const parallelism = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
    const { count, reason } = deriveWorkerCount({
        bind: config.host,
        override: (env.LIBMSSDK_WORKERS || '').trim(),
        parallelism,
    })
    const limits = {
        waitBudgetMs: parsePositiveInt(env.LIBMSSDK_WAIT_BUDGET_MS, DEFAULT_WAIT_BUDGET_MS),
        queueLimit: parsePositiveInt(env.LIBMSSDK_QUEUE_LIMIT, count * QUEUE_LIMIT_PER_WORKER),
    }
    const rateSettings = rateLimitSettingsFromEnv(env)
    const limiter = createRateLimiter(rateSettings)
    // 控制文件默认跟身份文件放同一个 state 目录；直接构造时没有 identityFile 就不轮询。
    const modeFile =
        rateSettings.modeFile ||
        (config.identityFile ? path.join(path.dirname(config.identityFile), 'rate-limit.mode') : '')
    const diagnostics = { queueDepth: () => 0, queueLimit: 0 }

    const pool = createWorkerPool({
        workerCount: count,
        spawn: index => spawn(index, env),
        log,
        onGiveUp,
        respawnBaseMs: parsePositiveInt(env.LIBMSSDK_WORKER_RESPAWN_BASE_MS, 1000),
        respawnCapMs: parsePositiveInt(env.LIBMSSDK_WORKER_RESPAWN_CAP_MS, GIVE_UP_WINDOW_MS),
    })
    // 实际值与来由都要说出来：绑定地址一变进程数就变，日志不写就等于让人猜。
    // 限流参数也一并写：默认是否生效、当前是拦还是只看，部署者要能一眼确认。
    const rateInfo = limiter.stats()
    log('dispatcher', {
        workers: count,
        reason,
        ...limits,
        bind: config.host,
        rateLimit: {
            mode: rateInfo.mode,
            ratePerSecond: rateInfo.ratePerSecond,
            burst: rateInfo.burst,
            maxBuckets: rateInfo.maxBuckets,
        },
    })

    const server = createDispatcher({
        config: { ...config, ...limits },
        pool,
        log,
        limiter,
        modeFile,
        modePollMs: rateSettings.pollMs,
        diagnostics,
        fallback: createFallback ? createFallback({ pool, limiter, diagnostics }) : null,
    })
    // start() 只会 resolve（每台 worker 的 settled 没有 reject 路径），但 spawn 本身可能同步抛
    pool.start().catch(error =>
        log('dispatcher-start-failed', {
            message: redactMachinePaths(String(error?.message || error), [config.bdmsModule, config.clientDir]),
        }))
    return { server, pool, limiter }
}
