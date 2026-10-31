// 老 HTTP 服务：/sign 在默认路径上已经切到分发器（src/dispatcher.mjs），这里保留的是
// 过渡期的其余端点，由 src/serve.mjs 挂到同一个监听上：
//
//   GET  /healthz          服务状态（预热未完成时 503；#9 再拆成 /livez /readyz）
//   GET  /stat             诊断计数（活跃桶、允许/拒绝、队列深度、worker 数；IP 脱敏）
//   GET  /config           非敏感配置摘要（可选鉴权；#9 删除）
//   POST /probe            真机自检（#9 收成命令行子命令）
//   POST /track/stream     /probe 的别名（#9 删除）
//
// 直接构造 createServer 时仍带 /sign，给本地用例与旧路径用；默认服务不会走到它。
// #7 的验收是「502 从所有出口消失」，所以这里的失败也走同一张分类表。
// #8 起 POST 计算端点（/sign、/probe、/track/stream）在鉴权之后过同一个限流器；
// /stat、/healthz、/config 不过限流计数，也不打访问日志。

import http from 'node:http'
import { maskDeviceId } from './config.mjs'
import { isAuthorized, assertServeAuth } from './auth.mjs'
import { errorResponse, normalizeSignRequest, signResponse, ValidationError } from './contract.mjs'
import { ERROR_KINDS, failureResponse, rateLimitedResponse } from './errors.mjs'
import { buildTrackV2Request, summarizeTrackV2Response } from './probe.mjs'
import { logError, logEvent } from './log.mjs'
import { clientKey, maskAddressKey } from './ratelimit.mjs'
import { requestPathname } from './route.mjs'

function readBody(request, limit) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        request.on('data', chunk => {
            size += chunk.length
            if (size > limit) {
                // 不 destroy：客户端要读得到那句 400，而不是在上传中途拿到连接重置。
                // 剩下的字节继续排掉，只是不再缓冲（与分发器的处理一致）。
                reject(new ValidationError(`请求体超过 ${limit} 字节`))
                request.resume()
                return
            }
            chunks.push(chunk)
        })
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        request.on('error', reject)
    })
}

async function postJson(url, body, headers, timeoutMs) {
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    return { status: response.status, text }
}

/**
 * 过渡期端点处理器。
 *
 * `readiness` 由默认服务注入（至少一台 worker 就绪）；不给时保持老行为（只看模块在不在）。
 * 不提前回 200 很重要：预热期间任何一次 200 都会让编排器的起始宽限期当场作废。
 *
 * `rateLimiter` 与 `stats` 同样由默认服务注入：#8 起 POST 计算端点共享同一个限流器，
 * /stat 读同一份装配状态。直接构造 createServer 的老用例不注入时行为不变。
 */
export function createLegacyHandler({ config, signer, readiness = null, rateLimiter = null, stats = null }) {
    // 直接构造老处理器（或 createServer）的嵌入用法也守同一条规则：非回环 + 没令牌不开门。
    assertServeAuth(config)
    return async (request, response) => {
        const started = Date.now()
        // 只取 pathname，且解析本身永不抛：这条 handler 是 async，抛出去就是 unhandled
        // rejection，而一条匿名请求（`GET // HTTP/1.1`）就够触发。畸形目标按「没这条路由」处理。
        const pathname = requestPathname(request)
        const send = (status, payload) => {
            const text = JSON.stringify(payload)
            response.statusCode = status
            response.setHeader('Content-Type', 'application/json; charset=utf-8')
            response.setHeader('Content-Length', Buffer.byteLength(text))
            response.end(text)
        }
        const sendFailure = failure => {
            if (response.headersSent || response.writableEnded) return
            const text = JSON.stringify(failure.body)
            response.writeHead(failure.status, {
                ...failure.headers,
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(text),
            })
            response.end(text)
        }
        const authorized = () => isAuthorized(request, config)

        try {
            if (pathname === '/healthz') {
                const ready = readiness ? Boolean(readiness()) : true
                send(ready ? 200 : 503, {
                    ok: ready,
                    ready,
                    service: 'libmssdk',
                    version: config.version,
                    bdmsAvailable: signer.available,
                    deviceId: maskDeviceId(config.deviceId || signer.deviceId),
                    auth: Boolean(config.token),
                    platform: process.platform,
                })
                return
            }
            if (pathname === '/stat') {
                if (request.method !== 'GET' || !stats) {
                    send(404, errorResponse('not found', 'not_found'))
                    return
                }
                // 诊断端点：不过限流计数、不打访问日志；地址在 statResponse 里已经脱敏。
                send(200, stats())
                return
            }
            if (pathname === '/config') {
                if (!authorized()) {
                    sendFailure(failureResponse(ERROR_KINDS.UNAUTHORIZED, { message: '缺少或错误的 Bearer Token' }))
                    return
                }
                send(200, {
                    ok: true,
                    version: config.version,
                    bdmsModule: config.bdmsModule,
                    bundledBdms: config.bundledBdms,
                    clientDir: config.clientDir,
                    deviceId: maskDeviceId(config.deviceId),
                    // 设备身份：客户端可以照抄这份，保证「签名器 / URL 参数」用同一份设备号
                    // （上游不要求它等于账号登录设备，见 docs/INVESTIGATION-DEVICE-ENTITLEMENT.md）
                    identity: {
                        device_id: config.deviceId,
                        iid: config.iid,
                        fp: config.fp,
                        source: config.identitySource,
                    },
                    requestTimeoutMs: config.requestTimeoutMs,
                })
                return
            }
            if (request.method !== 'POST' || !['/sign', '/probe', '/track/stream'].includes(pathname)) {
                send(404, errorResponse('not found', 'not_found'))
                return
            }
            if (!authorized()) {
                sendFailure(failureResponse(ERROR_KINDS.UNAUTHORIZED, { message: '缺少或错误的 Bearer Token' }))
                return
            }
            if (rateLimiter) {
                const now = Date.now()
                const key = clientKey(request, { trustProxy: config.trustProxy })
                const decision = rateLimiter.check(key, now)
                if (decision.wouldDeny) {
                    const failure = rateLimitedResponse({ retryAtMs: decision.retryAtMs, nowMs: now })
                    logEvent('rate-limited', {
                        path: pathname,
                        method: request.method,
                        ip: maskAddressKey(key),
                        mode: decision.mode,
                        retryAfterSeconds: failure.body.retry_after_seconds,
                    })
                    if (!decision.allowed) {
                        // 请求体还没读：排掉剩余字节再关连接，客户端才读得到这个 429。
                        request.resume()
                        response.setHeader('Connection', 'close')
                        sendFailure(failure)
                        return
                    }
                }
            }

            // readBody 的 ValidationError（体超限）原样保留；只有 JSON 解析失败才是 400。
            const text = await readBody(request, config.maxBodyBytes)
            let payload
            try {
                payload = JSON.parse(text || '{}')
            } catch {
                throw new ValidationError('请求体不是合法 JSON')
            }

            // 直接构造 createServer 的 /sign 只给本地用例与旧路径；默认路径的模块/配置错误
            // 由池子的 blocker 报 SIGNER_UNAVAILABLE，不会走到这里。
            if (pathname === '/sign') {
                const spec = normalizeSignRequest(payload)
                const signed = signer.sign({
                    url: spec.url,
                    headers: spec.headers,
                    deviceId: spec.deviceId,
                })
                logEvent('sign', {
                    path: spec.url.split('?')[0],
                    method: spec.method,
                    headers: Object.keys(spec.headers).length,
                    bodyBytes: spec.body.length,
                    deviceId: maskDeviceId(signed.deviceId),
                    elapsedMs: Date.now() - started,
                })
                send(200, signResponse({ ...signed, elapsedMs: Date.now() - started }))
                return
            }

            // /probe 与 /track/stream：签一次名后真的去打接口
            const deviceId = String(payload.device_id || payload.deviceId || config.deviceId || '').trim()
            const spec = buildTrackV2Request({
                trackId: payload.track_id || payload.trackId || payload.id,
                deviceId,
                iid: payload.iid || config.iid || '',
                fp: payload.fp || config.fp || '',
                userAgent: payload.user_agent || payload.userAgent || undefined,
                cookie: payload.cookie || '',
                queueType: payload.queue_type || payload.queueType || undefined,
                sceneName: payload.scene_name || payload.sceneName || undefined,
            })
            const signed = signer.sign({ url: spec.url, headers: spec.headers, deviceId })
            const headers = { ...spec.headers, ...signed.headers }
            const upstream = await postJson(spec.url, spec.body, headers, config.requestTimeoutMs)
            const summary = summarizeTrackV2Response(upstream.text, payload.track_id)
            logEvent('probe', {
                trackId: String(payload.track_id || ''),
                deviceId: maskDeviceId(signed.deviceId),
                http: upstream.status,
                bodyBytes: summary.bodyBytes || 0,
                fullTrack: Boolean(summary.fullTrack),
                elapsedMs: Date.now() - started,
            })
            if (pathname === '/probe') {
                if (upstream.status === 200) {
                    send(200, {
                        ok: Boolean(summary.accepted),
                        http: upstream.status,
                        ...summary,
                    })
                    return
                }
                // 上游非 200 不再是 502（本进程不是网关）：按「必须有人来修」收口，
                // 诊断字段照旧平铺在回包里。#9 把 /probe 收成命令行子命令后整条消失。
                sendFailure(
                    failureResponse(ERROR_KINDS.INTERNAL_ERROR, {
                        message: `上游没有接受这次签名（HTTP ${upstream.status}）`,
                        details: { http: upstream.status, ...summary },
                    }),
                )
                return
            }
            send(200, {
                ok: true,
                track_id: payload.track_id,
                name: summary.name,
                duration_seconds: summary.trackDurationSeconds,
                stream: summary.bestGear
                    ? {
                          quality: summary.bestGear.quality || summary.bestGear.gear,
                          bitrate: summary.bestGear.bitrate,
                          size: summary.bestGear.size,
                          codec: summary.bestGear.codec,
                      }
                    : null,
                gears: summary.gears,
                full_track: Boolean(summary.fullTrack),
                hint: summary.hint,
            })
        } catch (error) {
            const kind = error instanceof ValidationError ? ERROR_KINDS.INVALID_REQUEST : ERROR_KINDS.INTERNAL_ERROR
            logError(`${request.method} ${pathname ?? '(畸形请求目标)'}: ${error.message}`)
            sendFailure(failureResponse(kind, { message: String(error?.message || '内部错误') }))
        }
    }
}

/** 直接起一个只跑老处理器的服务（本地用例、旧路径）。默认服务见 src/serve.mjs。 */
export function createServer({ config, signer, readiness }) {
    return http.createServer(createLegacyHandler({ config, signer, readiness }))
}
