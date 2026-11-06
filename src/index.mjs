#!/usr/bin/env node
// libmssdk 入口：
//   libmssdk serve      启动 HTTP 服务（默认 http://127.0.0.1:8899；主进程监听 + worker 计算）
//   libmssdk bridge     stdio 模式：stdin 收 SignRequest、stdout 出 SignResponse
//                       （给 libresoda 的 CommandSignature 直接调用）
//   libmssdk selftest   检查 bdms.node / 设备号 / 能否生成签名
//   libmssdk probe      真机自检：签名后打接口，判断整曲还是试听
//                       （上游自检只有这一个入口，HTTP 层不再提供 /probe）
//   libmssdk config     打印当前配置摘要（设备号脱敏）

import path from 'node:path'
import { loadConfig, maskDeviceId, missingExplicitBdmsModule, VERSION } from './config.mjs'
import { BdmsSigner } from './bdms.mjs'
import { startServe, stopPoolQuietly } from './serve.mjs'
import { probeTrack } from './probe.mjs'
import { errorResponse, normalizeSignRequest, signResponse } from './contract.mjs'
import { logError, logEvent, redactMachinePaths, redactMachinePathsDeep } from './log.mjs'

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

/** 布尔开关只认 `--name`；不把下一个 token 当值吃掉。 */
function hasFlag(name) {
    return process.argv.includes(`--${name}`)
}

// selftest / config 的输出经常被原样贴进求助帖：默认隐掉本机路径，只有显式 --verbose 才打原文。
const showMachinePaths = hasFlag('verbose')

/** 会出现在输出里的本机路径。长的排前面：父目录先命中会把更长的文件路径切成半截。 */
function machinePathLocations() {
    return [
        config.identityFile,
        config.bdmsModule,
        config.clientDir,
        config.identityFile && path.dirname(config.identityFile),
        config.bdmsModule && path.dirname(config.bdmsModule),
    ]
        .filter(Boolean)
        .sort((left, right) => right.length - left.length)
}

/** 单条路径的显示形式：默认换掉，--verbose 才给原文。 */
function displayPath(value) {
    return showMachinePaths ? value : redactMachinePaths(value, machinePathLocations())
}

function redactForDisplay(value) {
    return showMachinePaths ? value : redactMachinePathsDeep(value, machinePathLocations())
}

/** selftest 里那行 `state (<身份文件>)`：默认整条隐掉，--verbose 才给原文。 */
function identitySummary() {
    const file = showMachinePaths ? `(${config.identityFile})` : '(本机路径)'
    return `${config.identitySource} ${file}`
}

/**
 * 显式给出的模块路径写错了，在开始监听前就拦下：否则 serve 照样监听，只是每条 /sign 都回
 * SIGNER_UNAVAILABLE，排查时很容易先怀疑 worker 而不是一个拼错的路径。
 * 默认探测路径不在这里判——resolveBdmsModule() 已经只返回存在的候选。
 * selftest / config 不走这条检查：它们的工作正是把「找不到模块」如实报出来。
 */
function assertExplicitBdmsModule() {
    if (!missingExplicitBdmsModule()) return
    const shown = displayPath(config.bdmsModule)
    throw new Error(
        `显式指定的 bdms.node 不存在（LIBMSSDK_BDMS_MODULE / QISHUI_BDMS_PATH）：${shown}` +
            '（用 config --verbose 查看解析到的原文）',
    )
}

async function readStdin() {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
}

async function commandServe() {
    assertExplicitBdmsModule()
    // /sign 由主进程排队、worker 计算；签名以外的端点（健康检查与弃用回执）由 src/endpoints.mjs
    // 承接。主进程那份 signer 只给 selftest / probe / bridge 用，不进 HTTP 层。
    const entry = startServe({ config })
    const { server, pool } = entry
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
        await stopPoolQuietly(pool, [config.bdmsModule, config.clientDir])
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
        // 第一件事是让 /readyz 改口：编排器从这一步起就不该再把流量派过来了。
        // 排空窗口（LIBMSSDK_DRAIN_DELAY_MS，默认 0）只推迟停监听，不推迟改口。
        // beginShutdown() 同步执行 markClosing()，日志因此排在改口之后。
        const stopping = entry.beginShutdown()
        logEvent('shutdown', { source: 'signal', drainDelayMs: entry.drainDelayMs })
        // 先停止接新连接，等在飞/排队请求收完，再收 worker：反过来会把排队中的请求直接掐掉。
        stopping.finally(() => process.exit(0))
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
        identity: identitySummary(),
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
    process.stdout.write(`${JSON.stringify(redactForDisplay(report), null, 2)}\n`)
    if (!report.signOk) process.exitCode = 1
}

async function commandProbe() {
    const trackId = argValue('track') || process.env.LIBMSSDK_PROBE_TRACK_ID || process.argv[3]
    const cookie = argValue('cookie') || process.env.LIBMSSDK_COOKIE || ''
    const deviceId = argValue('device') || config.deviceId
    const report = await probeTrack({
        signer,
        trackId,
        deviceId,
        iid: argValue('iid') || config.iid,
        fp: argValue('fp') || config.fp,
        cookie,
        timeoutMs: config.requestTimeoutMs,
    })
    // 设备号只以脱敏形式出现：这条命令的输出经常被人直接贴进求助帖
    process.stdout.write(
        `${JSON.stringify({ http: report.http, deviceId: maskDeviceId(report.deviceId), ...report.summary }, null, 2)}\n`,
    )
    if (!report.summary.fullTrack) process.exitCode = 1
}

function commandConfig() {
    const summary = {
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
    }
    process.stdout.write(`${JSON.stringify(redactForDisplay(summary), null, 2)}\n`)
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
