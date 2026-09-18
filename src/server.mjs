// HTTP 服务：把签名能力暴露成局域网/本机接口，供 libresoda 等客户端调用。
//
//   GET  /healthz          服务状态（不泄露凭据）
//   GET  /config           非敏感配置摘要（可选鉴权）
//   POST /sign             核心：{url,method,body,headers} → {ok,headers:{X-Helios,X-Medusa}}
//   POST /probe            真机自检：签名 + 打真实接口，判断整曲/试听
//   POST /track/stream     /probe 的别名，返回更贴近播放器的字段

import http from 'node:http'
import crypto from 'node:crypto'
import { maskDeviceId } from './config.mjs'
import { errorResponse, normalizeSignRequest, signResponse, ValidationError } from './contract.mjs'
import { buildTrackV2Request, summarizeTrackV2Response } from './probe.mjs'
import { logError, logEvent } from './log.mjs'

function timingSafeEqual(a, b) {
    const left = Buffer.from(String(a))
    const right = Buffer.from(String(b))
    if (left.length !== right.length) return false
    return crypto.timingSafeEqual(left, right)
}

function readBody(request, limit) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        request.on('data', chunk => {
            size += chunk.length
            if (size > limit) {
                reject(new ValidationError(`请求体超过 ${limit} 字节`))
                request.destroy()
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

export function createServer({ config, signer }) {
    const server = http.createServer(async (request, response) => {
        const started = Date.now()
        const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
        const send = (status, payload) => {
            const text = JSON.stringify(payload)
            response.statusCode = status
            response.setHeader('Content-Type', 'application/json; charset=utf-8')
            response.setHeader('Content-Length', Buffer.byteLength(text))
            response.end(text)
        }
        const authorized = () => {
            if (!config.token) return config.allowAnonymous || true
            const header = request.headers.authorization || ''
            const token = header.startsWith('Bearer ') ? header.slice(7) : ''
            return token.length > 0 && timingSafeEqual(token, config.token)
        }

        try {
            if (url.pathname === '/healthz') {
                send(200, {
                    ok: true,
                    service: 'libmssdk',
                    version: config.version,
                    bdmsAvailable: signer.available,
                    deviceId: maskDeviceId(config.deviceId || signer.deviceId),
                    auth: Boolean(config.token),
                    platform: process.platform,
                })
                return
            }
            if (url.pathname === '/config') {
                if (!authorized()) {
                    send(401, errorResponse('unauthorized', 'unauthorized'))
                    return
                }
                send(200, {
                    ok: true,
                    version: config.version,
                    bdmsModule: config.bdmsModule,
                    bundledBdms: config.bundledBdms,
                    clientDir: config.clientDir,
                    deviceId: maskDeviceId(config.deviceId),
                    // 设备身份：客户端可以照抄这份，保证「签名器 / URL 参数 / cookie 会话」同设备
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
            if (request.method !== 'POST' || !['/sign', '/probe', '/track/stream'].includes(url.pathname)) {
                send(404, errorResponse('not found', 'not_found'))
                return
            }
            if (!authorized()) {
                send(401, errorResponse('unauthorized', 'unauthorized'))
                return
            }

            const payload = JSON.parse((await readBody(request, config.maxBodyBytes)) || '{}')

            if (url.pathname === '/sign') {
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
            if (url.pathname === '/probe') {
                send(upstream.status === 200 ? 200 : 502, {
                    ok: Boolean(summary.accepted),
                    http: upstream.status,
                    ...summary,
                })
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
            const isValidation = error instanceof ValidationError
            logError(`${request.method} ${url.pathname}: ${error.message}`)
            send(isValidation ? 400 : 502, errorResponse(error.message, isValidation ? 'invalid_request' : 'signer_error'))
        }
    })
    return server
}
