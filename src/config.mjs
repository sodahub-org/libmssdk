// 运行时配置：用户提供的原生模块 + 自动生成的设备身份；环境变量用于配置或覆盖。

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.1.0'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 本地原生模块目录：用户可把官方客户端的两个文件复制到这里。 */
const LOCAL_NATIVE_DIR = path.join(PROJECT_ROOT, 'vendor', 'soda-music')
const DEFAULT_STATE_DIR = path.join(PROJECT_ROOT, 'data')

const env = key => (process.env[key] || '').trim()

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

/** bdms.node 路径：客户端里真正干签名的原生模块。 */
function resolveBdmsModule() {
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

/** 设备号格式与官方客户端一致：16 位数字，首位 1-8。 */
export function randomDeviceId() {
    const first = 1 + (crypto.randomBytes(1)[0] % 8)
    const rest = crypto.randomBytes(8).readBigUInt64BE() % 1000000000000000n
    return `${first}${rest.toString().padStart(15, '0')}`
}

/** 身份文件目录：默认 <仓库>/data，可用 LIBMSSDK_STATE_DIR 改到别处。 */
export function stateDir() {
    return env('LIBMSSDK_STATE_DIR') || DEFAULT_STATE_DIR
}

export function identityFile(dir = stateDir()) {
    return path.join(dir, 'identity.json')
}

function readIdentity(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (/^[1-8]\d{15}$/.test(String(parsed.device_id || ''))) return parsed
    } catch {
        /* 不存在或损坏都当作首次运行 */
    }
    return null
}

function writeIdentity(file, identity) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
        return true
    } catch {
        return false
    }
}

/**
 * 设备身份（device_id / iid / fp）。
 *
 * 优先级：环境变量覆盖 > state 目录里的 identity.json > 首次运行随机生成并落盘。
 * 落盘是为了让设备号跨重启保持稳定 —— 每次重启换设备号会让服务端看到的设备画像跳变。
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
            persisted: true,
        }
    }

    let stored = readIdentity(file)
    let persisted = true
    if (!stored) {
        const generated = {
            device_id: randomDeviceId(),
            iid: randomDeviceId(),
            created_at: new Date().toISOString(),
        }
        generated.fp = generated.device_id
        persisted = writeIdentity(file, generated)
        stored = generated
    }

    return {
        deviceId: stored.device_id,
        iid: overrideIid || stored.iid || '',
        fp: overrideFp || stored.fp || stored.device_id,
        source: overrideIid || overrideFp ? 'state+env' : 'state',
        stateFile: file,
        persisted,
    }
}

export function loadConfig() {
    const clientDir = resolveClientDir()
    const bdmsModule = resolveBdmsModule()
    const identity = resolveIdentity()
    return {
        version: VERSION,
        host: env('LIBMSSDK_BIND') || env('BIND') || '127.0.0.1',
        port: Number(env('LIBMSSDK_PORT') || env('PORT') || 8899),
        token: env('LIBMSSDK_TOKEN') || env('QISHUI_SIGNER_TOKEN'),
        allowAnonymous: (env('LIBMSSDK_ALLOW_ANONYMOUS') || '') === '1',
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
