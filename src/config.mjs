// 运行时配置：用户提供的原生模块 + 自动生成的设备身份；环境变量用于配置或覆盖。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { identityFile, prepareStoredIdentity } from './identity.mjs'

export const VERSION = '0.1.0'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 本地原生模块目录：用户可把官方客户端的两个文件复制到这里。 */
const LOCAL_NATIVE_DIR = path.join(PROJECT_ROOT, 'vendor', 'soda-music')

const env = key => (process.env[key] || '').trim()

// 导出给用例对照：deploy/run.sh 里的「TRUST_PROXY 打开了」必须与这里同一口径（见
// test/deploy-run-guard.test.mjs），这张表改动时两边要一起动。
export const envFlag = key => ['1', 'true', 'yes', 'on'].includes(env(key).toLowerCase())

/** 用户提供的原生模块信息（文件缺失时为 ''，便于回退到客户端目录或显式环境变量）。 */
export function bundledNative() {
    const modulePath = path.join(LOCAL_NATIVE_DIR, 'bdms.node')
    const libraryPath = path.join(LOCAL_NATIVE_DIR, 'metasecml.dll')
    return {
        dir: LOCAL_NATIVE_DIR,
        modulePath: fs.existsSync(modulePath) ? modulePath : '',
        libraryPath: fs.existsSync(libraryPath) ? libraryPath : '',
    }
}

/** 官方客户端安装目录：优先显式指定，否则按平台惯例探测。 */
function resolveClientDir() {
    const explicit = env('LIBMSSDK_CLIENT_DIR') || env('QISHUI_CLIENT_DIR')
    if (explicit) return explicit
    const roots = [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Soda Music'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', '汽水音乐'),
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Soda Music'),
        process.platform === 'darwin' && '/Applications/SodaMusic.app/Contents/Resources',
        path.join(os.homedir(), 'Applications'),
    ].filter(Boolean)
    for (const root of roots) {
        if (!fs.existsSync(root)) continue
        const versions = fs
            .readdirSync(root)
            .filter(name => /^\d+\.\d+\.\d+/.test(name))
            .sort()
        return versions.length > 0 ? path.join(root, versions.at(-1)) : root
    }
    return ''
}

/** bdms.node 路径：客户端里真正干签名的原生模块。worker 侧也要用它，但别顺带调 loadConfig()。 */
export function resolveBdmsModule() {
    const explicit = env('LIBMSSDK_BDMS_MODULE') || env('QISHUI_BDMS_PATH')
    if (explicit) return explicit
    const local = bundledNative().modulePath
    if (local) return local
    const dir = env('LIBMSSDK_CLIENT_DIR') || env('QISHUI_CLIENT_DIR')
    if (!dir) return ''
    const candidates = [
        path.join(dir, 'resources', 'app.asar.unpacked', 'bdms.node'),
        path.join(dir, 'resources', 'app.asar.unpacked', 'mssdk', 'bdms.node'),
        path.join(dir, 'bdms.node'),
    ]
    return candidates.find(candidate => fs.existsSync(candidate)) || ''
}

/**
 * 设备身份（device_id / iid / fp）。
 *
 * 优先级：环境变量覆盖 > state 目录里的 identity.json > 独占创建生成并落盘。
 * 落盘是为了让设备号跨重启保持稳定 —— 每次重启换设备号会让服务端看到的设备画像跳变。
 * 「读到就用 / 读不到就生成」的原子性由 src/identity.mjs 的独占创建保证，这里不再自己判断。
 */
export function resolveIdentity() {
    const overrideDevice = env('LIBMSSDK_DEVICE_ID') || env('QISHUI_DEVICE_ID')
    const overrideIid = env('LIBMSSDK_IID')
    const overrideFp = env('LIBMSSDK_FP')
    const file = identityFile()

    if (overrideDevice) {
        // 显式覆盖时不碰 state 文件，便于临时用别的设备号做对照实验
        return {
            deviceId: overrideDevice,
            iid: overrideIid,
            fp: overrideFp || overrideDevice,
            source: 'env',
            stateFile: file,
            created: false,
            persisted: true,
        }
    }

    const stored = prepareStoredIdentity()

    return {
        deviceId: stored.identity.device_id,
        iid: overrideIid || stored.identity.iid || '',
        fp: overrideFp || stored.identity.fp || stored.identity.device_id,
        source: overrideIid || overrideFp ? 'state+env' : 'state',
        stateFile: file,
        created: stored.created,
        persisted: stored.persisted,
    }
}

/** 主进程入口专用：这一步会准备身份文件（可能独占创建它）。worker 侧不要调这里，直接用 identity.mjs 的只读入口。 */
export function loadConfig() {
    const clientDir = resolveClientDir()
    const bdmsModule = resolveBdmsModule()
    const identity = resolveIdentity()
    return {
        version: VERSION,
        host: env('LIBMSSDK_BIND') || env('BIND') || '127.0.0.1',
        port: Number(env('LIBMSSDK_PORT') || env('PORT') || 8899),
        token: env('LIBMSSDK_TOKEN') || env('QISHUI_SIGNER_TOKEN'),
        // 只在前置反向代理会重写 X-Forwarded-For 时才打开；默认只认 TCP 对端地址。
        trustProxy: envFlag('LIBMSSDK_TRUST_PROXY'),
        deviceId: identity.deviceId,
        iid: identity.iid,
        fp: identity.fp,
        identitySource: identity.source,
        identityFile: identity.stateFile,
        identityPersisted: identity.persisted,
        bundledBdms: bundledNative().modulePath,
        clientDir,
        bdmsModule,
        requestTimeoutMs: Number(env('LIBMSSDK_UPSTREAM_TIMEOUT_MS') || 15000),
        maxBodyBytes: Number(env('LIBMSSDK_MAX_BODY_BYTES') || 256 * 1024),
    }
}

/** 打日志/自检用：设备号只露头尾。 */
export function maskDeviceId(deviceId) {
    const value = String(deviceId || '')
    if (value.length <= 6) return value ? '*'.repeat(value.length) : ''
    return `${value.slice(0, 3)}***${value.slice(-3)}`
}
