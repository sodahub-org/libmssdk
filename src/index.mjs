#!/usr/bin/env node
// libmssdk 入口：
//   libmssdk serve      启动 HTTP 服务（默认 http://127.0.0.1:8899）
//   libmssdk bridge     stdio 模式：stdin 收 SignRequest、stdout 出 SignResponse
//                       （给 libresoda 的 CommandSignature 直接调用）
//   libmssdk selftest   检查 bdms.node / 设备号 / 能否生成签名
//   libmssdk probe      真机自检：签名后打接口，判断整曲还是试听
//   libmssdk config     打印当前配置摘要（设备号脱敏）

import { loadConfig, maskDeviceId, VERSION } from './config.mjs'
import { BdmsSigner } from './bdms.mjs'
import { createServer } from './server.mjs'
import { buildTrackV2Request, summarizeTrackV2Response } from './probe.mjs'
import { errorResponse, normalizeSignRequest, signResponse } from './contract.mjs'
import { logError, logEvent } from './log.mjs'

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
    const server = createServer({ config, signer })
    await new Promise(resolve => server.listen(config.port, config.host, resolve))
    logEvent('serve', {
        url: `http://${config.host}:${config.port}`,
        version: VERSION,
        bdmsAvailable: signer.available,
        auth: Boolean(config.token),
    })
    const shutdown = () => server.close(() => process.exit(0))
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
                allowAnonymous: config.allowAnonymous,
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
