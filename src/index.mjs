#!/usr/bin/env node
// libmssdk 入口：
//   libmssdk serve      启动 HTTP 服务（默认 http://127.0.0.1:8899；主进程监听 + worker 计算）
//   libmssdk bridge     stdio 模式：stdin 收 SignRequest、stdout 出 SignResponse
//                       （给 libresoda 的 CommandSignature 直接调用）
//   libmssdk selftest   检查 bdms.node / 设备号 / 能否生成签名
//   libmssdk probe      真机自检：签名后打接口，判断整曲还是试听
//   libmssdk config     打印当前配置摘要（设备号脱敏）

import { loadConfig, maskDeviceId, VERSION } from './config.mjs'
import { BdmsSigner } from './bdms.mjs'
import { startServe } from './serve.mjs'
import { buildTrackV2Request, summarizeTrackV2Response } from './probe.mjs'
import { errorResponse, normalizeSignRequest, signResponse } from './contract.mjs'
import { logError, logEvent } from './log.mjs'

// 身份在这里就完成「读到或用独占创建生成」。真正保证不分裂的是独占创建本身（见 src/identity.mjs），
// 不是进程角色分工：现在每个入口命令（含被按次拉起的 bridge）启动都会走到这里，靠 wx 收敛。
// worker 池（#5）那条路径不走这里：src/worker.mjs 只用 identity.mjs 的只读入口 readStoredIdentity()，
// 手上没有任何创建能力。
const config = loadConfig()
const signer = new BdmsSigner({ modulePath: config.bdmsModule, deviceId: config.deviceId })

function argValue(name, fallback = '') {
    const index = process.argv.indexOf(`--${name}`)
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

async function readStdin() {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
}

async function commandServe() {
    // 默认路径（#7）：/sign 由主进程排队、worker 计算；过渡端点仍由老处理器承接。
    const { server, pool } = startServe({ config, signer })
    try {
        await new Promise((resolve, reject) => {
            const onError = error => reject(error)
            server.once('error', onError)
            server.listen(config.port, config.host, () => {
                server.off('error', onError)
                resolve()
            })
        })
    } catch (error) {
        // 端口没起来也要把已经 fork 的 worker 收掉。预热中的 worker 可能正卡在同步采样里，
        // shutdown 消息要等它跑完；给一秒宽限，之后强制退出，别让端口错误把进程挂住。
        // 收尾自己的失败只记一笔，不能盖住真正要报的端口错误。
        await pool.stop().catch(stopError => logError(`pool.stop: ${stopError?.message || stopError}`))
        setTimeout(() => process.exit(1), 1000).unref()
        throw error
    }
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : config.port
    logEvent('serve', {
        url: `http://${config.host}:${port}`,
        version: VERSION,
        workers: pool.size,
        bdmsAvailable: signer.available,
        auth: Boolean(config.token),
        // persisted=false 意味着设备号只在内存里、重启就变：启动日志要当场说出去
        identityPersisted: config.identityPersisted,
    })
    let closing = false
    const shutdown = () => {
        // 第二次 Ctrl+C 是逃生口：第一次已经在等在飞请求收尾了，再按就立刻退。
        if (closing) {
            process.exit(1)
            return
        }
        closing = true
        // 先停止接新连接，等在飞/排队请求收完，再收 worker：反过来会把排队中的请求直接掐掉。
        server.close(() => {
            pool.stop().finally(() => process.exit(0))
        })
        server.closeIdleConnections?.()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}

async function commandBridge() {
    try {
        const payload = JSON.parse((await readStdin()) || '{}')
        const spec = normalizeSignRequest(payload)
        const signed = signer.sign({ url: spec.url, headers: spec.headers, deviceId: spec.deviceId })
        process.stdout.write(JSON.stringify(signResponse(signed)))
    } catch (error) {
        process.stderr.write(String(error?.message || error))
        process.exit(1)
    }
}

async function commandSelftest() {
    const report = {
        version: VERSION,
        platform: process.platform,
        node: process.version,
        bdmsModule: config.bdmsModule || '(未找到)',
        bundledBdms: Boolean(config.bundledBdms) && config.bundledBdms === config.bdmsModule,
        clientDir: config.clientDir || '(未找到)',
        deviceId: maskDeviceId(config.deviceId) || '(未配置)',
        iid: maskDeviceId(config.iid) || '(未配置)',
        fp: maskDeviceId(config.fp) || '(未配置)',
        identity: `${config.identitySource} (${config.identityFile})`,
    }
    try {
        const signed = signer.sign({
            url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088&device_id=1&fp=1',
            headers: { 'user-agent': 'LunaPC/selftest', 'content-type': 'application/json' },
            deviceId: config.deviceId || '1',
        })
        report.signOk = true
        report.signatureLengths = Object.fromEntries(
            Object.entries(signed.headers).map(([name, value]) => [name, String(value).length]),
        )
    } catch (error) {
        report.signOk = false
        report.error = String(error?.message || error)
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.signOk) process.exitCode = 1
}

async function commandProbe() {
    const trackId = argValue('track') || process.env.LIBMSSDK_PROBE_TRACK_ID || process.argv[3]
    const cookie = argValue('cookie') || process.env.LIBMSSDK_COOKIE || ''
    const deviceId = argValue('device') || config.deviceId
    const spec = buildTrackV2Request({
        trackId,
        deviceId,
        iid: argValue('iid') || config.iid,
        fp: argValue('fp') || config.fp,
        cookie,
    })
    const signed = signer.sign({ url: spec.url, headers: spec.headers, deviceId })
    const response = await fetch(spec.url, {
        method: 'POST',
        headers: { ...spec.headers, ...signed.headers },
        body: spec.body,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
    })
    const text = await response.text()
    const summary = summarizeTrackV2Response(text, trackId)
    process.stdout.write(
        `${JSON.stringify({ http: response.status, deviceId: maskDeviceId(signed.deviceId), ...summary }, null, 2)}\n`,
    )
    if (!summary.fullTrack) process.exitCode = 1
}

function commandConfig() {
    process.stdout.write(
        `${JSON.stringify(
            {
                version: VERSION,
                host: config.host,
                port: config.port,
                auth: Boolean(config.token),
                trustProxy: config.trustProxy,
                clientDir: config.clientDir,
                bdmsModule: config.bdmsModule,
                identity: {
                    deviceId: maskDeviceId(config.deviceId),
                    iid: maskDeviceId(config.iid),
                    fp: maskDeviceId(config.fp),
                    source: config.identitySource,
                    file: config.identityFile,
                    persisted: config.identityPersisted,
                },
            },
            null,
            2,
        )}\n`,
    )
}

const command = (process.argv[2] || 'serve').toLowerCase()
try {
    switch (command) {
        case 'serve':
            await commandServe()
            break
        case 'bridge':
            await commandBridge()
            break
        case 'selftest':
            await commandSelftest()
            break
        case 'probe':
            await commandProbe()
            break
        case 'config':
            commandConfig()
            break
        case '--version':
        case 'version':
            process.stdout.write(`${VERSION}\n`)
            break
        default:
            process.stdout.write(
                `${JSON.stringify(
                    errorResponse(`未知命令 ${command}（可用：serve / bridge / selftest / probe / config）`, 'unknown_command'),
                )}\n`,
            )
            process.exitCode = 2
    }
} catch (error) {
    logError(error?.message || error)
    process.exitCode = 1
}
