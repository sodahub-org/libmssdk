#!/usr/bin/env node
// 取证中转：把「本机已登录播放器实际发出的设备身份」记进一份只读的抓包件。
//
// 为什么要它：#10 的最后一格要的是一份「上游见过的真实设备身份」。播放器与签名器之间
// 走明文 HTTP，签名请求里就带着那条待签的完整 URL —— 设备号在这份里现成交出来，
// 不用装根证书、不用改 hosts、不用动系统代理。用完 Ctrl+C 停掉，播放器改回原来的 signer_url。
//
// 凭据边界：Cookie 与 Authorization 的值一律不落盘（只记字段名与个数）；`x-helios` / `x-medusa`
// 是逐请求签名，也不记。落盘的只有设备身份、公共参数里的形状字段与请求头名——UA 的值不存。
// 拒绝时打的 `event=deny` 会带上收到的请求行与 Origin（压成一行、截断）：那是判定依据，不是凭据。
// 抓包件在 POSIX 上是 0600（Windows 的 NTFS 不认这个位，那里靠的是账号所有权 + 放在仓库外），
// 并且拒绝写进仓库目录——真实设备号属于「不得入库」的那一类。
//
//   node tools/signer-tee.mjs --upstream http://127.0.0.1:8899/sign --out <仓库外的路径>
//   node tools/signer-tee.mjs --upstream https://signer.example/sign --port 18899 --out <路径>
//   然后把播放器的 signer_url 指到 http://127.0.0.1:<port>/sign，随便播一首，Ctrl+C。
//   上游走明文 http 时只认字面回环（127/8 与 [::1]）：`localhost` 连到哪儿由 hosts 与解析器决定，不算。

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
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

/** 从命令行取 `--name` 后面那个值；没给或给空就回退。 */
function argValue(name, fallback = '') {
    const index = process.argv.indexOf(`--${name}`)
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

/**
 * 从一条签名请求里取出身份与形状。返回 `{record, reason}`，三种出口：
 * 三个号齐全 → 有 record；不是业务请求（没有 `device_id`）或 URL 解析不了 → 两边都空，安静；
 * 是业务请求但 `iid` / `fp` 缺一个 → record 为空、reason 给出缺字段，由调用方出声。
 * 「身份不齐」要单独出声：那种请求确实带着设备号，只是不完整——把它当无关流量咽下去，
 * 取证白跑就看不见原因了。
 */
export function captureRecord({ url, headers = {}, method = 'POST', tsMs }) {
    let parsed
    try {
        parsed = new URL(String(url))
    } catch {
        return { record: null, reason: null }
    }
    const query = parsed.searchParams
    const deviceId = String(query.get('device_id') || '').trim()
    if (!deviceId) return { record: null, reason: null }
    const iid = String(query.get('iid') || '').trim()
    const fp = String(query.get('fp') || '').trim()
    if (!iid || !fp) return { record: null, reason: '缺 iid / fp' }
    const cookie = String(headers.cookie || headers.Cookie || '')
    const record = {
        at: new Date(Number(tsMs) || Date.now()).toISOString(),
        method: String(method).toUpperCase(),
        path: parsed.pathname,
        identity: { deviceId, iid, fp },
        shape: Object.fromEntries(SHAPE_PARAMS.map(key => [key, String(query.get(key) || '')])),
        headerNames: [...new Set(Object.keys(headers).map(name => String(name).toLowerCase()))].sort(),
        cookieFields: cookie ? cookie.split(';').filter(item => item.trim()).length : 0,
    }
    return { record, reason: null }
}

/** 打到终端的那一行：设备号只留首尾，曲名与完整曲目号根本不进这里。 */
export function formatCapture(record) {
    const { deviceId, iid, fp } = record.identity
    return (
        `event=tee ${record.method} ${record.path}｜device=${maskDeviceId(deviceId)}(${deviceId.length}位)｜` +
        `iid=${maskDeviceId(iid)}(${iid.length}位)｜fp=${maskDeviceId(fp)}(${fp.length}位)｜` +
        `版本=${record.shape.version_name || '?'}｜头名=${record.headerNames.length}条｜cookie字段=${record.cookieFields}`
    )
}

/**
 * 真实路径统一走 `.native`：Windows 上普通 `realpathSync` 不展开 8.3 短名（`LIBMSS~1`
 * 原样返回），`.native` 会换成长名；护栏必须跟 `openSync` 落到同一处。
 */
function realpathOf(value) {
    return fs.realpathSync.native(value)
}

/** 仓库根的真实路径：链接绕过来的判断要跟真实路径比，不能跟拼出来的字面路径比。 */
const REAL_REPO_ROOT = (() => {
    try {
        return realpathOf(REPO_ROOT)
    } catch {
        return REPO_ROOT
    }
})()

/** 链接链最多跟 40 跳：与内核 MAXSYMLINKS 同一量级，坏链别把解析拖成死循环。 */
const MAX_LINK_HOPS = 40
/** 路径分段：Windows 认两种分隔符，POSIX 只认 `/`（反斜杠可以是文件名的一部分）。 */
const SEGMENT_SPLIT = path.sep === '\\' ? /[\\/]+/ : /\/+/

/** 把一段路径拆成「起点 + 队列」：绝对路径从自己的根开始，相对路径从 baseDir 开始。 */
function startOf(value, baseDir) {
    if (!path.isAbsolute(value)) return { resolved: baseDir, queue: value.split(SEGMENT_SPLIT).filter(Boolean) }
    const parsed = path.parse(value)
    return { resolved: parsed.root, queue: value.slice(parsed.root.length).split(SEGMENT_SPLIT).filter(Boolean) }
}

/**
 * 按内核语义解析一个可能还不存在的路径：逐段跟随链接，`..` 作用在「已经解析过链接」的位置上。
 * `path.resolve` 只做字面折叠，遇到「链接段 + ..」会与内核算出不同的落点；护栏判的必须是
 * 内核最后真正写入的位置。遇到真缺段就按字面接上——那一段之下不可能再有链接（open 也会失败）。
 */
function resolveTargetPath(baseDir, target, hops) {
    const start = startOf(target, baseDir)
    let resolved = start.resolved
    const queue = start.queue
    let used = hops
    while (queue.length) {
        const segment = queue.shift()
        if (segment === '.') continue
        if (segment === '..') {
            resolved = path.dirname(resolved)
            continue
        }
        const candidate = path.join(resolved, segment)
        let stat
        try {
            stat = fs.lstatSync(candidate)
        } catch (error) {
            if (error.code !== 'ENOENT') throw unverifiablePathError(error)
            return path.join(resolved, segment, ...queue)
        }
        if (!stat.isSymbolicLink()) {
            resolved = candidate
            continue
        }
        if (used >= MAX_LINK_HOPS) throw unverifiablePathError({ code: 'ETOOMANYLINKS' })
        used += 1
        let next
        try {
            next = fs.readlinkSync(candidate)
        } catch (error) {
            throw unverifiablePathError(error)
        }
        const nested = startOf(next, resolved)
        resolved = nested.resolved
        queue.unshift(...nested.queue)
    }
    return resolved
}

/**
 * 末段通常还不存在（那是准备新建的抓包件），所以从最近的已存在父目录解析真实路径，再把尾巴接回去。
 * 只有 ENOENT 算「这一段还不存在」；其它错误（EACCES / ELOOP / ENAMETOOLONG）或退到根仍失败都拒——
 * 护栏宁可误杀，也不降级成只判字面路径。
 * ENOENT 还要再分一格：末段本身可能是个「指向不存在目标」的链接。`realpathSync` 报 ENOENT，
 * 但 `openSync` 会顺着链接把文件建到目标那儿——所以链接目标必须解析出来再判，不能当成不存在。
 */
function resolveRealPath(resolved, hops = 0) {
    const tail = []
    let cursor = resolved
    for (;;) {
        try {
            return path.join(realpathOf(cursor), ...tail.reverse())
        } catch (error) {
            // EACCES / ELOOP / ENAMETOOLONG 说明路径本身不成立，往上退只会把护栏降级成
            // 只判字面路径——那正是它要防的那一格，所以直接拒，不猜。
            if (error.code !== 'ENOENT') throw unverifiablePathError(error)
            let dangling = false
            try {
                dangling = fs.lstatSync(cursor).isSymbolicLink()
            } catch {
                // lstat 也看不见这一段：它确实还不存在，往上退。
            }
            if (dangling) {
                // 跳数耗尽不是「路径不存在」：给它自己的码，别让报错把操作者带偏。
                if (hops >= MAX_LINK_HOPS) throw unverifiablePathError({ code: 'ETOOMANYLINKS' })
                let target
                try {
                    target = fs.readlinkSync(cursor)
                } catch (linkError) {
                    throw unverifiablePathError(linkError)
                }
                // 相对目标以「链接所在目录的真实路径」为基准；目标内部若还有「链接段 + ..」，
                // 也必须逐段跟——字面折叠会算到另一处，而 open 建文件落在内核算出的那一处。
                const linkParent = path.dirname(cursor)
                let baseDir = linkParent
                if (!path.isAbsolute(target)) {
                    try {
                        baseDir = realpathOf(linkParent)
                    } catch (parentError) {
                        throw unverifiablePathError(parentError)
                    }
                }
                const resolvedTarget = resolveTargetPath(baseDir, target, hops + 1)
                // 逐段解析只看结构；短名/大小写这类归一仍要交给 realpath，否则会和长名仓库根对不上。
                return path.join(resolveRealPath(resolvedTarget, hops + 1), ...tail.reverse())
            }
            const parent = path.dirname(cursor)
            // 退到根还解析不了，同样拒：宁可误杀，也不退回字面判断。
            if (parent === cursor) throw unverifiablePathError(error)
            tail.push(path.basename(cursor))
            cursor = parent
        }
    }
}

/** 落笔前护栏的错误码：写入口靠它把「被护栏拒了」和磁盘失败分开报。 */
const GUARD_ERROR_CODES = new Set(['EOUTSIDEREPO', 'EUNVERIFIABLEPATH'])

/** 把「解析不了真实路径」包成带自己码的错误：写入口据此别把护栏拒绝报成磁盘失败。 */
function unverifiablePathError(error) {
    const wrapped = new Error(`无法确认抓包件的真实路径（code=${error.code || error.name}）：护栏不能降级成字面判断`)
    wrapped.code = 'EUNVERIFIABLEPATH'
    return wrapped
}

/** candidate 等于 root 或在它下面都算「里面」；`..<分隔符>` 与跨盘绝对路径算出去。 */
function insideRepo(candidate, root) {
    const relative = path.relative(root, candidate)
    // 「出去了」只有两种形态：以 `..<分隔符>` 开头，或跨盘时给出绝对路径。
    // 只看了 `..` 前缀就会把仓库里名为 `..cache` 的目录判成外面，护栏恰好在这一格落空。
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * 抓包件写进仓库目录就等于把真实设备号往提交里送，直接拒。
 * 字面路径和解析后的真实路径都要判：仓库外放一个指进仓库的链接（Windows 上 `mklink /J` 不用特权），
 * 只看字面会放行，而 `openSync` 会跟随链接把内容写进仓库里。
 */
export function assertOutsideRepo(target) {
    const resolved = path.resolve(target)
    if (insideRepo(resolved, REPO_ROOT) || insideRepo(resolveRealPath(resolved), REAL_REPO_ROOT)) {
        const error = new Error('--out 不能在仓库目录里：真实设备号不入库，请指到仓库外的路径')
        // 带上自己的码：写入口复用这条判据时，调用方要能把它和磁盘失败分开报。
        error.code = 'EOUTSIDEREPO'
        throw error
    }
    return resolved
}

/**
 * 出站判据要用「连接语义」，不能借 `isLoopbackBind` 的「绑定语义」：
 * 绑定到 `localhost` 时内核只听本机，这是对的；而 `http://localhost:8899` 连到哪儿
 * 由 hosts 与解析器决定，明文 cookie 会跟着那个解析结果走。所以这里只认字面回环：
 * 127/8 整段与 `[::1]`。
 */
function isLoopbackConnectTarget(hostname) {
    const value = String(hostname || '').trim().toLowerCase()
    const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
    return bare === '::1' || (net.isIPv4(bare) && bare.startsWith('127.'))
}

/**
 * 上游地址的判据：必须 http(s)，而且非回环就只能走 https。
 * 绑定收在回环保护不了出站那一跳——转发出去的是整份 SignRequest（`headers.cookie` 的值在里面）
 * 外加原样转发的令牌。文件头给的远端用法本来就是 `https://signer.example/sign`，这里把这句话管住。
 */
export function assertUpstreamUrl(upstream) {
    let parsed
    try {
        parsed = new URL(String(upstream))
    } catch {
        throw new Error('--upstream 必须是 http(s) 绝对地址')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('--upstream 必须是 http(s) 绝对地址')
    if (parsed.protocol === 'http:' && !isLoopbackConnectTarget(parsed.hostname)) {
        throw new Error('--upstream 走明文 http 时只认字面回环地址（127.0.0.1 / ::1）：转发出去那份请求体里带着 cookie；远端只能 https')
    }
    return parsed.toString()
}

/**
 * 把一条记录追加进抓包件。这是唯一的写入口：落笔前再判一次「不在仓库里」，
 * 启动时判过的那一次挡不住开了几十分钟里被换掉的父目录。
 */
function appendRecord(file, record) {
    // 判据写进写入口本身（与 AGENTS 约定 5 同一个思路）：启动时判过一次，但这台中转可能开着
    // 几十分钟，父目录在这段时间里被换成指进仓库的链接时，只有落笔前这次能拦住。
    const target = assertOutsideRepo(file)
    const handle = fs.openSync(target, 'a', 0o600)
    try {
        // 先把权限定下来再写：`openSync` 的 mode 会被既有 umask 削掉，而复用一份权限更宽的既有文件时，
        // 第一条（写着完整设备号的）记录不该以旧权限落地哪怕一小会儿。
        try {
            fs.fchmodSync(handle, 0o600)
        } catch {
            // Windows 上 NTFS 权限不认这个位；文件在仓库外、由本机账号所有，够用。
        }
        fs.writeSync(handle, `${JSON.stringify(record)}\n`)
    } finally {
        fs.closeSync(handle)
    }
}

/**
 * 回显「收到的事实」时压成一行：对端能塞进请求行/头里的控制字符不能借日志插图或换行。
 * Node 的头值是 latin1，0x80–0x9f 的 C1 会原样进来（例如 U+009B 就是 CSI）；DEL 与
 * Unicode 行分隔符 U+2028 / U+2029 同样会破坏「一行一条」的口径，一起换成 `?`。
 */
function received(value, limit = 80) {
    const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?')
    return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 读完整请求体；超过上限就返回 null，由调用方回 413。 */
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

/**
 * 起一台取证中转，Promise 解析为 server。判据都在这里复查，而不是只写在命令行：
 * host 必须是回环；上游只许 https 或字面回环 http；抓包件不在仓库目录里。
 * `log` / `warn` / `format` 是注入接缝：终端读数、兜底警告、终端行拼装，默认值即生产行为。
 */
export function start({
    upstream,
    host,
    port,
    out,
    log = text => process.stdout.write(text),
    // 兜底读取端默认回落到 log；log 自己坏了就退回 stderr。诊断走的 report 也拿它兜底。
    warn = text => {
        try {
            log(text)
        } catch {
            process.stderr.write(text)
        }
    },
    format = formatCapture,
}) {
    // 判据放在入口本身，不放调用方身上：这台中转会把请求原样转发，绑到非回环就等于对外提供服务。
    if (!isLoopbackBind(host)) throw new Error('只允许绑回环地址（127.0.0.1 / ::1）：它会把请求原样转发，不对外提供服务')
    // 出站与落盘两条判据也在这里：只写在命令行那一层，`start({...})` 的直调就绕过去了。
    const upstreamTarget = assertUpstreamUrl(upstream)
    if (!out) throw new Error('需要 --out <抓包件路径>（仓库外；POSIX 上 0600）')
    const captureFile = assertOutsideRepo(out)
    /**
     * 诊断行打不出去不能改口：log 坏了退回 warn，warn 也坏就放弃这一行。
     * 响应码必须由请求本身决定，不能被终端状态带着走——拒绝尤其如此。
     */
    const report = text => {
        try {
            log(text)
        } catch {
            try {
                warn(text)
            } catch {
                // 两条出口都坏了：诊断让位，响应照发。
            }
        }
    }
    const server = http.createServer((request, response) => {
        const reply = (status, payload) => {
            response.writeHead(status, { 'content-type': 'application/json' })
            response.end(JSON.stringify(payload))
        }
        // 只从请求行取路径，Host 不参与：这台中转认的就只有 /sign 这一个入口。
        const requestPath = String(request.url || '').split('?')[0]
        // 每一道拒绝都要出声，并带上「收到的事实」：操作者只看得见终端，悄悄回 4xx 等于
        // 「护栏有，但没人知道它挡了什么」；带上收到的值，下一次窗口才能自己回答「谁被挡了」。
        if (request.method !== 'POST' || requestPath !== '/sign') {
            report(`event=deny 404 不是 POST /sign（收到 ${received(request.method)} ${received(requestPath)}）\n`)
            return reply(404, { ok: false, error: '只转发 POST /sign' })
        }
        // 只认 JSON：浏览器 no-cors 的 simple POST 能送 text/plain 而不必预检，这一道就是拦它的。
        const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
        if (contentType !== 'application/json') {
            report(`event=deny 415 请求体不是 application/json（收到 ${received(contentType || '(没有)')}）\n`)
            return reply(415, { ok: false, error: '请求体必须是 application/json' })
        }
        // 这台机器没有跨源调用方：桌面签名客户端不发 Origin，浏览器页面才发。带 Origin 就不是该收的那种请求。
        if (request.headers.origin) {
            report(`event=deny 403 带 Origin 的请求不收（Origin=${received(request.headers.origin)}）\n`)
            return reply(403, { ok: false, error: '不收跨源请求' })
        }
        readBody(request)
            .then(async text => {
                if (text === null) {
                    // 413 最容易被误读成「中转挂了」：调用方拿到一个它没预期的状态码，这里必须留一行。
                    report(`event=deny 413 请求体超出上限（上限 ${MAX_BODY_BYTES} 字节），这条不收\n`)
                    return reply(413, { ok: false, error: '请求体超出上限' })
                }
                let record = null
                let reason = null
                try {
                    const signRequest = normalizeSignRequest(JSON.parse(text || '{}'))
                    const captured = captureRecord({
                        url: signRequest.url,
                        headers: signRequest.headers,
                        method: signRequest.method,
                        tsMs: signRequest.ts_ms,
                    })
                    record = captured.record
                    reason = captured.reason
                } catch {
                    // 解析不了就单纯转发：这台中转的职责是记录能记录的东西，不是替签名服务做校验。
                    // 要出声，但不复述内容——报文里可能带着 cookie 与令牌。
                    report('event=skip 这条请求体解析不了，只转发不记录\n')
                }
                // 带着设备号却缺 iid / fp：是业务请求，只是身份不齐。不出声就等于悄悄少记一条。
                if (reason) report(`event=skip ${reason}，这条只转发不落盘\n`)
                if (record) {
                    // 拼终端那一行与落盘是两种失败：格式坏了不能报成「抓包件写不进去」。
                    let line = null
                    let formatError = null
                    try {
                        line = format(record)
                    } catch (error) {
                        formatError = error
                    }
                    // 写不进去是另一回事：抓包件空了就等于没取证，所以这条单独出声。
                    let written = false
                    try {
                        appendRecord(captureFile, record)
                        written = true
                    } catch (error) {
                        // 落笔前被护栏拒了不是 I/O 故障：把「被谁挡了、为什么」说出来，别伪装成磁盘问题。
                        if (GUARD_ERROR_CODES.has(error.code)) {
                            report(`event=error 落笔前被护栏拒了（${error.message}），这条只转发没记录\n`)
                        } else {
                            report(`event=error 抓包件写不进去（code=${error.code || error.name}），这条只转发没记录\n`)
                        }
                        // 没落盘就不打「已记录」那一行。
                        line = null
                    }
                    // 格式失败这一句放在落盘之后说：先说的那句不能替后面那次尝试打包票。
                    if (formatError) {
                        report(
                            `event=error 终端行拼不出来（code=${formatError.code || formatError.name}），` +
                                `这一条${written ? '已照原样落盘（读数没打出来）' : '只转发没记录'}\n`,
                        )
                    }
                    // 落盘成功之后才写终端：这一步失败不能改口说「抓包件写不进去」——那一行确实进件了。
                    if (line) {
                        try {
                            log(`${line}\n`)
                        } catch (error) {
                            // 只说这一行确实进了抓包件、写终端时抛了什么码；不打「有没有打出来」的包票——
                            // 抛错之前字节可能已经落进日志文件了。
                            try {
                                warn(`event=warn 这一行已进抓包件；写终端时抛错（code=${error.code || error.name}）\n`)
                            } catch {
                                // warn 也写不出去：这一行已在件里，响应不能因此失败。
                            }
                        }
                    }
                }
                const upstreamResponse = await fetch(upstreamTarget, {
                    method: 'POST',
                    // 不跟跳转：这台中转的职责是转发给指定上游，不是替它追重定向——
                    // 默认跟随会把带着 cookie 的那份请求体重发到跳转目的地。
                    redirect: 'error',
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

/** CLI 入口：校验参数、起中转、等 SIGINT/SIGTERM 收尾。 */
async function main() {
    const host = argValue('listen', '127.0.0.1')
    const port = Number(argValue('port', '18899'))
    const upstream = argValue('upstream')
    const out = argValue('out')
    if (!upstream) throw new Error('需要 --upstream <真正的签名服务 /sign 地址>')
    if (!out) throw new Error('需要 --out <抓包件路径>（仓库外；POSIX 上 0600）')
    // 这台中转会把请求原样转发出去，绑定收到谁那儿必须自己说得清：只许回环。
    if (!isLoopbackBind(host)) throw new Error('只允许绑回环地址（127.0.0.1 / ::1）：它会把请求原样转发，不对外提供服务')
    // 上游与落盘判据都在 start() 里复查：它是所有人共用的入口，这里只留命令行早退。
    const server = await start({ upstream, host, port, out, warn: text => process.stderr.write(text) })
    process.stderr.write(
        `取证中转已启动：http://${host}:${port}/sign → 转发给上游签名器；` +
            `抓包件=${path.basename(out)}（POSIX 上 0600，Windows 靠账号所有权 + 仓库外）\n`,
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
