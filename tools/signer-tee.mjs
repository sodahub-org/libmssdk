#!/usr/bin/env node
// 取证中转：把「本机已登录播放器实际发出的设备身份」记进一份只读的抓包件。
//
// 为什么要它：#10 的最后一格要的是一份「上游见过的真实设备身份」。播放器与签名器之间
// 走明文 HTTP，签名请求里就带着那条待签的完整 URL —— 设备号在这份里现成交出来，
// 不用装根证书、不用改 hosts、不用动系统代理。用完 Ctrl+C 停掉，播放器改回原来的 signer_url。
//
// 凭据边界：Cookie 与 Authorization 的值一律不落盘（只记字段名与个数）；`x-helios` / `x-medusa`
// 是逐请求签名，也不记。落盘的只有设备身份、公共参数里的形状字段、请求头名与 UA。
// 抓包件默认 0600，并且拒绝写进仓库目录——真实设备号属于「不得入库」的那一类。
//
//   node tools/signer-tee.mjs --upstream http://127.0.0.1:8899/sign --out <仓库外的路径>
//   node tools/signer-tee.mjs --upstream https://signer.example/sign --port 18899 --out <路径>
//   然后把播放器的 signer_url 指到 http://127.0.0.1:<port>/sign，随便播一首，Ctrl+C。

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isLoopbackBind } from '../src/dispatch.mjs'
import { normalizeSignRequest } from '../src/contract.mjs'
import { maskDeviceId } from '../src/config.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_BODY_BYTES = 256 * 1024
/** 只收这几个公共参数：它们决定请求形状，且不含个人标识。其余按键名丢掉，连名字都不记。 */
const SHAPE_PARAMS = [
    'app_name',
    'channel',
    'device_platform',
    'device_type',
    'os_version',
    'region',
    'geo_region',
    'tz_name',
    'version_name',
    'version_code',
]

function argValue(name, fallback = '') {
    const index = process.argv.indexOf(`--${name}`)
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

/**
 * 从一条签名请求里取出记录。没有 `device_id` 就不算一份身份（返回 null），
 * 免得把无关请求记进抓包件里，回头被当成抓到的那一份。
 */
export function captureRecord({ url, headers = {}, method = 'POST', tsMs }) {
    let parsed
    try {
        parsed = new URL(String(url))
    } catch {
        return null
    }
    const query = parsed.searchParams
    const deviceId = String(query.get('device_id') || '').trim()
    if (!deviceId) return null
    const cookie = String(headers.cookie || headers.Cookie || '')
    return {
        at: new Date(Number(tsMs) || Date.now()).toISOString(),
        method: String(method).toUpperCase(),
        path: parsed.pathname,
        identity: { deviceId, iid: String(query.get('iid') || '').trim(), fp: String(query.get('fp') || '').trim() },
        shape: Object.fromEntries(SHAPE_PARAMS.map(key => [key, String(query.get(key) || '')])),
        headerNames: [...new Set(Object.keys(headers).map(name => String(name).toLowerCase()))].sort(),
        cookieFields: cookie ? cookie.split(';').filter(item => item.trim()).length : 0,
    }
}

/** 打到终端的那一行：设备号只留首尾，曲名与完整曲目号根本不进这里。 */
export function formatCapture(record) {
    const { deviceId, iid, fp } = record.identity
    return (
        `event=tee ${record.method} ${record.path}｜device=${maskDeviceId(deviceId)}(${deviceId.length}位)｜` +
        `iid=${maskDeviceId(iid)}(${iid.length}位)｜fp=${maskDeviceId(fp)}(${fp.length}位)｜` +
        `版本=${record.shape.version_name || '?'}｜UA头=${record.headerNames.length}条｜cookie字段=${record.cookieFields}`
    )
}

/** 抓包件写进仓库目录就等于把真实设备号往提交里送，直接拒。 */
export function assertOutsideRepo(target) {
    const resolved = path.resolve(target)
    const relative = path.relative(REPO_ROOT, resolved)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        throw new Error('--out 不能在仓库目录里：真实设备号不入库，请指到仓库外的路径')
    }
    return resolved
}

function appendRecord(file, record) {
    const handle = fs.openSync(file, 'a', 0o600)
    try {
        fs.writeSync(handle, `${JSON.stringify(record)}\n`)
    } finally {
        fs.closeSync(handle)
    }
    // openSync 的 mode 会被既有 umask 削掉，已存在的文件也不受它影响，所以补一次显式 chmod。
    try {
        fs.chmodSync(file, 0o600)
    } catch {
        // Windows 上 NTFS 权限不认这个位；文件在仓库外、由本机账号所有，够用。
    }
}

async function readBody(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) return null
        chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
}

export function start({ upstream, host, port, out, log = text => process.stdout.write(text) }) {
    const server = http.createServer((request, response) => {
        const reply = (status, payload) => {
            response.writeHead(status, { 'content-type': 'application/json' })
            response.end(JSON.stringify(payload))
        }
        if (request.method !== 'POST') return reply(404, { ok: false, error: '只转发 POST /sign' })
        readBody(request)
            .then(async text => {
                if (text === null) return reply(413, { ok: false, error: '请求体超出上限' })
                let record = null
                try {
                    const signRequest = normalizeSignRequest(JSON.parse(text || '{}'))
                    record = captureRecord({
                        url: signRequest.url,
                        headers: signRequest.headers,
                        method: signRequest.method,
                        tsMs: signRequest.ts_ms,
                    })
                } catch {
                    // 解析不了就单纯转发：这台中转的职责是记录能记录的东西，不是替签名服务做校验。
                    // 要出声，但不复述内容——报文里可能带着 cookie 与令牌。
                    log('event=skip 这条请求体解析不了，只转发不记录\n')
                }
                // 写不进去是另一回事：抓包件空了就等于没取证，所以这条单独出声。
                if (record) {
                    try {
                        appendRecord(out, record)
                        log(`${formatCapture(record)}\n`)
                    } catch {
                        log('event=error 抓包件写不进去，这条只转发没记录\n')
                    }
                }
                const upstreamResponse = await fetch(upstream, {
                    method: 'POST',
                    headers: {
                        'content-type': request.headers['content-type'] || 'application/json',
                        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
                    },
                    body: text,
                    signal: AbortSignal.timeout(60_000),
                })
                const relayed = await upstreamResponse.text()
                const contentType = upstreamResponse.headers.get('content-type') || 'application/json'
                response.writeHead(upstreamResponse.status, { 'content-type': contentType })
                response.end(relayed)
            })
            .catch(error => {
                // 不回显底层错误原文：上游 URL 里可能带着令牌，fetch 的报错会把它一起带出来。
                reply(502, {
                    ok: false,
                    error: '上游签名器没有响应（中转不打印上游地址与凭据）',
                    cause: error?.name || 'Error',
                })
            })
    })
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve(server))
    })
}

async function main() {
    const host = argValue('listen', '127.0.0.1')
    const port = Number(argValue('port', '18899'))
    const upstream = argValue('upstream')
    const out = argValue('out')
    if (!upstream) throw new Error('需要 --upstream <真正的签名服务 /sign 地址>')
    if (!/^https?:\/\//i.test(upstream)) throw new Error('--upstream 必须是 http(s) 绝对地址')
    if (!out) throw new Error('需要 --out <抓包件路径>（仓库外，0600）')
    // 这台中转会把请求原样转发出去，绑定收到谁那儿必须自己说得清：只许回环。
    if (!isLoopbackBind(host)) throw new Error('只允许绑回环地址（127.0.0.1 / ::1）：它会把请求原样转发，不对外提供服务')
    const target = assertOutsideRepo(out)
    const server = await start({ upstream, host, port, out: target })
    process.stderr.write(
        `取证中转已启动：http://${host}:${port}/sign → 转发给上游签名器；抓包件=${path.basename(target)}（0600）\n`,
    )
    process.stderr.write('用完：Ctrl+C 停掉，再把播放器的 signer_url 改回原来那份。\n')
    await new Promise(resolve => {
        process.on('SIGINT', () => {
            server.close(resolve)
        })
        process.on('SIGTERM', () => {
            server.close(resolve)
        })
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        process.stderr.write(`${error.message}\n`)
        process.exitCode = 2
    })
}
