// 取证中转的离线用例：它站在「已登录播放器」与「签名服务」中间，
// 唯一的职责是把播放器真实发出的设备身份记进一份只在本机、落在仓库外的抓包件
// （POSIX 上 0600，NTFS 不认这个位），其余一律原样转发。
// 断言的都是外部可见的事实（转发出去的内容、落盘的那几行、回给调用方的状态码），
// 以及一条边界：凭据既不落盘也不回显。监听一律 listen(0)，三条用法守卫跑子进程但都在
// 起监听之前退出——不打网络，也不自选端口再绑定。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const { assertOutsideRepo, assertUpstreamUrl, captureRecord, formatCapture, start } = await import('../tools/signer-tee.mjs')

const SECRET_COOKIE = 'sessionid_ss=SECRET-COOKIE-VALUE'
const SECRET_TOKEN = 'Bearer SECRET-TOKEN-VALUE'
/** 夹具：真机在这条链路上发的是每请求一个毫秒时间戳，这里用一个固定值好比对。 */
const CAPTURED_ID = { deviceId: '1789435000000', iid: '1789435000001', fp: '1789435000000' }
const TRACK_V2_URL =
    'https://api.qishui.com/luna/pc/track_v2?ac=wifi&aid=386088&device_id=1789435000000&fp=1789435000000' +
    '&iid=1789435000001&os_version=Windows+11&region=cn&tz_name=Asia+Shanghai&version_code=30030000&version_name=3.3.0'

/** 一份真机形状的 SignRequest 夹具；`overrides` 覆盖其中的请求头。 */
function signRequest(overrides = {}) {
    return JSON.stringify({
        url: TRACK_V2_URL,
        method: 'POST',
        body: '{"track_id":"123"}',
        ts_ms: 1789435000000,
        headers: {
            'user-agent': 'LunaPC/3.3.0(359450208)',
            'content-type': 'application/json; charset=utf-8',
            'x-luna-is-local-user': '1',
            cookie: SECRET_COOKIE,
            ...overrides,
        },
    })
}

test('抓到的是 URL 里那份设备身份与形状字段，其余按键名丢掉', () => {
    const record = captureRecord({
        url: TRACK_V2_URL,
        method: 'POST',
        tsMs: 1789435000000,
        headers: { Cookie: SECRET_COOKIE, 'user-agent': 'LunaPC/3.3.0(359450208)', 'X-Luna-Is-Local-User': '1' },
    }).record
    assert.deepEqual(record.identity, { deviceId: '1789435000000', iid: '1789435000001', fp: '1789435000000' })
    assert.equal(record.at, new Date(1789435000000).toISOString())
    assert.equal(record.path, '/luna/pc/track_v2')
    assert.equal(record.method, 'POST')
    assert.equal(record.shape.version_name, '3.3.0')
    assert.equal(record.shape.os_version, 'Windows 11')
    assert.equal(record.shape.tz_name, 'Asia Shanghai', '查询串里的 + 就是空格，取出来要还原')
    assert.deepEqual(record.headerNames, ['cookie', 'user-agent', 'x-luna-is-local-user'], '头名统一小写并排序，便于比对形状')
    assert.equal(record.cookieFields, 1)
})

test('凭据一个字节都不落盘：cookie 值、签名值、令牌都不进记录', () => {
    const record = captureRecord({
        url: TRACK_V2_URL,
        headers: {
            cookie: SECRET_COOKIE,
            authorization: SECRET_TOKEN,
            'x-helios': 'SECRET-HELIOS',
            'x-medusa': 'SECRET-MEDUSA',
        },
    }).record
    const text = JSON.stringify(record)
    assert.ok(!text.includes('SECRET-COOKIE-VALUE'), 'cookie 值不得进抓包件')
    assert.ok(!text.includes('SECRET-HELIOS'), '签名值不得进抓包件')
    assert.ok(!text.includes('SECRET-MEDUSA'), '签名值不得进抓包件')
    assert.ok(!text.includes('SECRET-TOKEN-VALUE'), '令牌不得进抓包件')
    assert.ok(text.includes('authorization'), '但头名要留：它是要复刻的请求形状的一部分')
    assert.equal(record.cookieFields, 1)
})

test('没有 device_id 的请求不算一份身份，坏 URL 也不炸', () => {
    assert.equal(captureRecord({ url: 'https://api.qishui.com/luna/pc/me?iid=1' }).record, null)
    assert.equal(captureRecord({ url: 'not a url' }).record, null)
    assert.equal(captureRecord({ url: '' }).record, null)
    assert.equal(captureRecord({ url: '' }).reason, null, '无关流量不该出声')
})

test('业务请求但身份不齐：不落盘，且说清是缺字段', () => {
    const noIid = captureRecord({ url: 'https://api.qishui.com/luna/pc/track_v2?device_id=1789435000000&fp=1789435000000' })
    const noFp = captureRecord({ url: 'https://api.qishui.com/luna/pc/track_v2?device_id=1789435000000&iid=1789435000001' })
    const neither = captureRecord({ url: 'https://api.qishui.com/luna/pc/track_v2?device_id=1789435000000' })
    assert.equal(noIid.record, null)
    assert.equal(noFp.record, null)
    assert.equal(neither.record, null)
    assert.equal(noIid.reason, '缺 iid / fp')
    assert.equal(noFp.reason, '缺 iid / fp')
    assert.equal(neither.reason, '缺 iid / fp')
    const full = captureRecord({ url: TRACK_V2_URL })
    assert.equal(full.reason, null, '三个号齐全的照样过——这条守住误杀')
    assert.deepEqual(full.record.identity, { deviceId: '1789435000000', iid: '1789435000001', fp: '1789435000000' })
})

test('打到终端的那一行只留首尾：完整设备号不进日志', () => {
    const line = formatCapture(captureRecord({ url: TRACK_V2_URL }).record)
    assert.match(line, /178\*\*\*000/)
    assert.ok(!line.includes('1789435000000'), `设备号被整串打出来了：${line}`)
    assert.match(line, /13位/)
    assert.ok(!line.includes('SECRET'), 'cookie 值不该顺带出现')
})

test('抓包件不许落在仓库目录里：真实设备号属于不入库的那一类', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    assert.throws(() => assertOutsideRepo(path.join(repoRoot, 'capture.jsonl')), /不入库/)
    assert.throws(() => assertOutsideRepo(path.join(repoRoot, 'data', 'nested', 'capture.jsonl')), /不入库/)
    const outside = path.join(os.tmpdir(), 'libmssdk-tee-outside.jsonl')
    assert.equal(assertOutsideRepo(outside), path.resolve(outside))
})

// —— 转发这一半：真起两个进程内的 HTTP 服务，看它把什么交出去、把什么留下 ——

const openServers = []
async function listen(handler) {
    const server = http.createServer(handler)
    openServers.push(server)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return { server, url: `http://127.0.0.1:${server.address().port}/sign` }
}
/**
 * 「上游没人听」用一个保留端口（<1024）表达：undici 直接判 bad port，
 * 既不依赖某个端口当时有没有人听，也不用先占住再放开那种两步写法。
 */
const DEAD_UPSTREAM = 'http://127.0.0.1:1/sign'
/** 起一台中转，上游由调用方给。`...rest` 给用例注入 `warn` / `format` 这类接缝。 */
async function startTee({ upstream, out, log = () => {}, ...rest }) {
    const tee = await start({ upstream, host: '127.0.0.1', port: 0, out, log, ...rest })
    openServers.push(tee)
    return tee
}
after(async () => {
    for (const server of openServers) await new Promise(resolve => server.close(resolve))
})

test('原样转发给上游签名器，抓包件里只多一行身份；回包状态与内容照搬', async () => {
    const seen = []
    const logged = []
    const upstream = await listen((request, response) => {
        const chunks = []
        request.on('data', chunk => chunks.push(chunk))
        request.on('end', () => {
            seen.push({ body: Buffer.concat(chunks).toString('utf8'), authorization: request.headers.authorization })
            response.writeHead(201, { 'content-type': 'application/json' })
            response.end('{"ok":true,"headers":{"X-Helios":"A","X-Medusa":"B"}}')
        })
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-')), 'capture.jsonl')
    const tee = await startTee({ upstream: upstream.url, out, log: line => logged.push(line) })
    const port = tee.address().port
    const response = await fetch(`http://127.0.0.1:${port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: SECRET_TOKEN },
        body: signRequest(),
    })
    assert.equal(response.status, 201)
    assert.match(await response.text(), /X-Medusa/)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].body, signRequest(), '转发出去的请求体必须逐字节是调用方那一份')
    assert.equal(seen[0].authorization, SECRET_TOKEN, '令牌只过手，不进抓包件')

    const lines = fs.readFileSync(out, 'utf8').trim().split(/\r?\n/)
    assert.equal(lines.length, 1)
    assert.deepEqual(JSON.parse(lines[0]).identity, CAPTURED_ID)
    const text = fs.readFileSync(out, 'utf8')
    assert.ok(!text.includes('SECRET-COOKIE-VALUE'), 'cookie 值不得进抓包件')
    assert.ok(!text.includes('SECRET-TOKEN-VALUE'), '令牌不得进抓包件')
    // Windows 的 NTFS 不认这个位（工具自己与文档都这么写），所以只在 POSIX 上钉权限。
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(out).mode & 0o777, 0o600, '抓包件写着完整真实设备号，必须 0600')
    }

    // 上游没人听时报 502，且报文里不带本机/上游细节。
    const deadOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-')), 'dead.jsonl')
    const deadTee = await startTee({ upstream: DEAD_UPSTREAM, out: deadOut, log: line => logged.push(line) })
    const dead = await fetch(`http://127.0.0.1:${deadTee.address().port}/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: signRequest() })
    assert.equal(dead.status, 502)
    const deadText = await dead.text()
    assert.ok(!deadText.includes('127.0.0.1'), `报错漏出了上游地址：${deadText}`)
    assert.match(logged.join(''), /event=tee/, '打出去的那一行是脱敏读数')
    assert.ok(!logged.join('').includes('1789435000000'), '终端那一行不带完整设备号')
})

test('非 POST 不记录也不转发，坏 JSON 只转发不记录但要说出声', async () => {
    let hits = 0
    const logged = []
    const upstream = await listen((request, response) => {
        hits += 1
        request.resume()
        request.on('end', () => response.end('{"ok":true}'))
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-')), 'capture.jsonl')
    const tee = await startTee({ upstream: upstream.url, out, log: line => logged.push(line) })
    const base = `http://127.0.0.1:${tee.address().port}/sign`

    const wrongMethod = await fetch(base, { method: 'GET' })
    assert.equal(wrongMethod.status, 404)
    assert.equal(hits, 0, 'GET 不该被转发')

    const garbage = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
    })
    assert.equal(garbage.status, 200, '解析不了照样转发：记录是顺带的事')
    assert.equal(hits, 1)
    assert.equal(fs.existsSync(out), false, '坏 JSON 里没有身份，抓包件不该被创建')
    assert.match(logged.join(''), /event=skip/, '漏记一条要出声，否则「抓到了几条」根本对不上账')
    assert.ok(!logged.join('').includes('not json'), '出声也不复述报文内容')
})

test('没有 device_id 的请求转发但不进抓包件', async () => {
    const upstream = await listen((request, response) => {
        request.resume()
        request.on('end', () => response.end('{"ok":true}'))
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-')), 'capture.jsonl')
    const tee = await startTee({ upstream: upstream.url, out })
    const response = await fetch(`http://127.0.0.1:${tee.address().port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(signRequest()), url: 'https://api.qishui.com/luna/pc/me?iid=1' }),
    })
    assert.equal(response.status, 200)
    assert.equal(fs.existsSync(out), false)
})

test('抓包件写不进去时单独出声：这条只转发没记录，取证不会假装抓到了', async () => {
    const upstream = await listen((request, response) => {
        request.resume()
        request.on('end', () => response.end('{"ok":true}'))
    })
    const logged = []
    // 把抓包件指到一个目录上：openSync 必失败，失败原因与「解析不了」是两回事。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-dir-'))
    const tee = await startTee({ upstream: upstream.url, out: directory, log: line => logged.push(line) })
    const response = await fetch(`http://127.0.0.1:${tee.address().port}/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: signRequest() })
    assert.equal(response.status, 200, '落盘失败也不能把调用方晾着：转发照做')
    assert.match(logged.join(''), /event=error/, '写不进去要单独报，不能混成「解析不了」')
    assert.ok(!logged.join('').includes('event=skip'), '这条报文是好 JSON，不该报解析失败')
})

const teeCli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'signer-tee.mjs')
const repoRoot = path.resolve(path.dirname(teeCli), '..')
/** 用子进程跑工具本体：用法守卫失败必须发生在起监听之前。 */
function runTee(...args) {
    return spawnSync(process.execPath, [teeCli, ...args], { encoding: 'utf8' })
}

test('三道用法守卫都在起监听之前退出，报错也不带本机路径', () => {
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-')), 'capture.jsonl')

    // 它会原样转发出去，所以只许绑回环；这条得由启动路径守住，不看纯函数里的真值表。
    const publicBind = runTee('--upstream', DEAD_UPSTREAM, '--out', outside, '--listen', '10.0.0.5')
    assert.notEqual(publicBind.status, 0)
    assert.match(publicBind.stderr, /回环/)

    const insideRepo = runTee('--upstream', DEAD_UPSTREAM, '--out', path.join(repoRoot, 'capture.jsonl'))
    assert.notEqual(insideRepo.status, 0)
    assert.match(insideRepo.stderr, /不入库/)
    assert.ok(!insideRepo.stderr.includes(repoRoot), `报错漏出了仓库路径：${insideRepo.stderr}`)

    const noUpstream = runTee('--out', outside)
    assert.notEqual(noUpstream.status, 0)
    assert.match(noUpstream.stderr, /--upstream/)
})

test('仓库根目录本身也要拒：指到根就等于往提交里送设备号', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    assert.throws(() => assertOutsideRepo(repoRoot), /不入库/)
    assert.throws(() => assertOutsideRepo(repoRoot + path.sep), /不入库/)
})

test('名字以 .. 开头的目录其实在仓库里，也要拒：前缀不等于「出去了」', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    assert.throws(() => assertOutsideRepo(path.join(repoRoot, '..cache', 'capture.jsonl')), /不入库/)
    // 真的在仓库外的仍然放行，别把修法做成一律拒
    const outside = path.join(repoRoot, '..', 'libmssdk-tee-outside.jsonl')
    assert.equal(assertOutsideRepo(outside), path.resolve(outside))
})

test('仓库外的链接指进仓库：按解析后的真实路径判，不按字面路径判', t => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-link-'))
    const link = path.join(dir, 'into-repo')
    try {
        fs.symlinkSync(path.join(repoRoot, 'tools'), link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
        t.skip(`这台机器建不出链接：${error.code || error.message}`)
        return
    }
    try {
        assert.throws(() => assertOutsideRepo(path.join(link, 'capture.jsonl')), /不入库/)
    } finally {
        fs.rmSync(link, { force: true })
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('启动后父目录被换成指进仓库的链接：落笔前再判一次，一个字都进不了仓库', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-swap-'))
    const probeFile = 'capture-guard-probe.jsonl'
    const out = path.join(dir, probeFile)
    const logged = []
    const tee = await startTee({ upstream: DEAD_UPSTREAM, out, log: line => logged.push(line) })
    const moved = `${dir}-moved`
    fs.renameSync(dir, moved)
    try {
        fs.symlinkSync(path.join(repoRoot, 'tools'), dir, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
        t.skip(`这台机器建不出链接：${error.code || error.message}`)
        fs.rmSync(moved, { recursive: true, force: true })
        return
    }
    // 万一护栏失灵，别把探针行留在仓库里；正常路径下这个文件根本不该被创建。
    const inRepo = path.join(repoRoot, 'tools', probeFile)
    try {
        await fetch(`http://127.0.0.1:${tee.address().port}/sign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: signRequest(),
        })
        assert.equal(fs.existsSync(inRepo), false, '完整设备号被写进了仓库目录')
        const text = logged.join('')
        assert.match(text, /event=error 落笔前被护栏拒了/, `落笔前拦下了，但没说是护栏挡的：${text}`)
        assert.match(text, /不入库/, '护栏拒绝了却不给原因，操作者会当成磁盘故障')
    } finally {
        fs.rmSync(inRepo, { force: true })
        fs.rmSync(dir, { force: true })
        fs.rmSync(moved, { recursive: true, force: true })
    }
})

test('真实路径解析不了时护栏要拒，不许退回字面判断', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-loop-'))
    const loop = path.join(dir, 'loop')
    try {
        // 自指链接：realpath 会报 ELOOP（Windows 的 junction 上同样如此，且不需要特权）。
        fs.symlinkSync(loop, loop, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
        t.skip(`这台机器建不出自指链接：${error.code || error.message}`)
        return
    }
    try {
        assert.throws(
            () => assertOutsideRepo(path.join(loop, 'capture.jsonl')),
            /真实路径/,
            '解析失败被当成「末段还不存在」，护栏降级成了字面判断',
        )
    } finally {
        try {
            fs.rmSync(loop, { force: true })
        } catch {
            // 链接本身删不掉时，下面的递归删除还会再试一次
        }
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('悬空链接指进仓库：realpath 报 ENOENT 也不能当成「还不存在」', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-dangling-'))
    const link = path.join(dir, 'capture.jsonl')
    const target = path.join(repoRoot, 'tools', 'capture-dangling-probe.jsonl')
    try {
        // 指向一个还不存在的目标：realpath 报 ENOENT，但 openSync 会顺着链接把文件建到目标那儿。
        fs.symlinkSync(target, link, 'file')
    } catch (error) {
        t.skip(`这台机器建不出悬空链接：${error.code || error.message}`)
        return
    }
    try {
        assert.throws(() => assertOutsideRepo(link), /不入库/, '悬空链接被当成「还不存在」，护栏落在链接外面')
        assert.throws(
            () => start({ upstream: DEAD_UPSTREAM, host: '127.0.0.1', port: 0, out: link, log: () => {} }),
            /不入库/,
            '直调 start() 时悬空链接同样要拒',
        )
        assert.equal(fs.existsSync(target), false, '仓库里出现了本不该有的文件')
    } finally {
        fs.rmSync(link, { force: true })
        fs.rmSync(target, { force: true })
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('链接的父目录本身是链接时，相对目标要按真实父目录解析', t => {
    if (process.platform === 'win32') {
        t.skip('相对目标跨盘建不出来；这条只在 POSIX 上有意义')
        return
    }
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-alias-'))
    const realParent = path.join(base, 'real')
    const deep = path.join(base, 'a', 'b', 'c')
    const alias = path.join(deep, 'alias')
    const target = path.join(repoRoot, 'tools', 'capture-alias-probe.jsonl')
    try {
        fs.mkdirSync(realParent, { recursive: true })
        fs.mkdirSync(deep, { recursive: true })
        // 字面父目录（<base>/a/b/c/alias）比真实父目录（<base>/real）深：
        // 用字面父目录解析相对目标会落到仓库外，内核却按真实父目录把文件建进仓库。
        fs.symlinkSync(realParent, alias, 'dir')
        fs.symlinkSync(path.relative(realParent, target), path.join(realParent, 'capture.jsonl'), 'file')
    } catch (error) {
        t.skip(`这台机器建不出链接：${error.code || error.message}`)
        return
    }
    try {
        assert.throws(
            () => assertOutsideRepo(path.join(alias, 'capture.jsonl')),
            /不入库/,
            '相对目标按字面父目录解析，护栏判到了仓库外——内核却会把文件建进仓库',
        )
        assert.equal(fs.existsSync(target), false, '仓库里出现了本不该有的文件')
    } finally {
        fs.rmSync(alias, { force: true })
        fs.rmSync(path.join(realParent, 'capture.jsonl'), { force: true })
        fs.rmSync(target, { force: true })
        fs.rmSync(base, { recursive: true, force: true })
    }
})

test('只收 /sign：别的 path 一律 404，既不转发也不落盘', async () => {
    const seen = []
    const upstream = await listen((request, response) => {
        seen.push(request.url)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-path-')), 'capture.jsonl')
    const tee = await startTee({ upstream: upstream.url, out, log: () => {} })
    const response = await fetch(`http://127.0.0.1:${tee.address().port}/whatever-not-sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: signRequest(),
    })
    assert.equal(response.status, 404)
    assert.equal(seen.length, 0, '不该把这条转给上游')
    assert.equal(fs.existsSync(out), false, '不该落盘')
})

test('content-type 不是 JSON：415，不转发不落盘', async () => {
    const seen = []
    const upstream = await listen((request, response) => {
        seen.push(request.url)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-ctype-')), 'capture.jsonl')
    const tee = await startTee({ upstream: upstream.url, out, log: () => {} })
    const response = await fetch(`http://127.0.0.1:${tee.address().port}/sign`, {
        method: 'POST',
        // 浏览器 no-cors 的 simple POST 就发这个类型，不需要预检也能把 body 送到位
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: signRequest(),
    })
    assert.equal(response.status, 415)
    assert.equal(seen.length, 0, '不该把这条转给上游')
    assert.equal(fs.existsSync(out), false, '不该落盘')
})

test('带 Origin 的一律拒：本机桌面客户端不发这个头，只有网页会发', async () => {
    const seen = []
    const upstream = await listen((request, response) => {
        seen.push(request.url)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-origin-')), 'capture.jsonl')
    const tee = await startTee({ upstream: upstream.url, out, log: () => {} })
    const response = await fetch(`http://127.0.0.1:${tee.address().port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
        body: signRequest(),
    })
    assert.equal(response.status, 403)
    assert.equal(seen.length, 0, '不该把这条转给上游')
    assert.equal(fs.existsSync(out), false, '不该落盘')
})

test('落盘、终端、格式三种失败要各报各的：谁都不能混成「抓包件写不进去」', async () => {
    // 一、落盘失败：指到目录上，openSync 必抛——报的那行要带上 code，人才知道是哪一类失败
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-code-'))
    const loggedA = []
    const teeWithCollector = await startTee({
        upstream: DEAD_UPSTREAM,
        out: directory,
        log: line => loggedA.push(line),
    })
    await fetch(`http://127.0.0.1:${teeWithCollector.address().port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: signRequest(),
    })
    const textA = loggedA.join('')
    assert.match(textA, /event=error 抓包件写不进去（code=[A-Z_]+）/, `失败原因没带错误码：${textA}`)

    // 二、落盘成功但终端写不出：那一行确实在件里，就不能报成「抓包件写不进去」
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-logfail-')), 'capture.jsonl')
    const boom = {
        write(value) {
            if (String(value).startsWith('event=tee')) throw new Error('stdout 被占了')
            return true
        },
    }
    const warnings = []
    // 兜底读取端由 start() 注入：用例不再 patch 全局 process.stderr.write。
    const teeB = await startTee({
        upstream: DEAD_UPSTREAM,
        out,
        log: text => boom.write(text),
        warn: text => warnings.push(text),
    })
    await fetch(`http://127.0.0.1:${teeB.address().port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: signRequest(),
    })
    assert.equal(fs.existsSync(out), true, '这条其实落盘了')
    assert.equal(fs.readFileSync(out, 'utf8').trim().split(/\r?\n/).length, 1)
    const textB = warnings.join('')
    assert.match(textB, /event=warn/, '终端写失败要单独说，不能沉默')
    assert.match(textB, /code=[A-Za-z_]+/, `没带错误码：${JSON.stringify(textB)}`)
    assert.ok(!/没打出来/.test(textB), `还在断言打没打出来：${JSON.stringify(textB)}`)

    // 三、记录已经成形、只是终端行拼不出来：报格式失败，不能报成「抓包件写不进去」——
    // 旧写法把 appendRecord 与 formatCapture 放在同一个 try 里，这一格会把格式错误说成落盘错误。
    const outC = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-format-')), 'capture.jsonl')
    const loggedC = []
    const teeC = await startTee({
        upstream: DEAD_UPSTREAM,
        out: outC,
        log: line => loggedC.push(line),
        format: () => {
            throw new Error('记录形状变了')
        },
    })
    await fetch(`http://127.0.0.1:${teeC.address().port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: signRequest(),
    })
    const textC = loggedC.join('')
    assert.match(textC, /event=error 终端行拼不出来/, `格式失败没单独报：${JSON.stringify(textC)}`)
    assert.ok(!textC.includes('抓包件写不进去'), `格式失败被报成了写不进去：${JSON.stringify(textC)}`)
    assert.match(textC, /已照原样落盘/, '格式坏了但这一条其实进了件，结果要说准——不能只喊「失败」')
    const captured = fs.readFileSync(outC, 'utf8').trim()
    assert.equal(captured.split(/\r?\n/).length, 1, '格式失败不该连累落盘：这一条确实进件了')
    assert.deepEqual(JSON.parse(captured).identity, CAPTURED_ID)
})

test('默认 warn 回落到 log：不注入 warn 时，那句警告也进同一汇', async () => {
    const upstream = await listen((request, response) => {
        request.resume()
        request.on('end', () => response.end('{"ok":true}'))
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-warn-')), 'capture.jsonl')
    // 第一次写日志（读数那一行）让 log 抛，逼出 warn 那条路；warn 自己没有注入，默认应当回落到同一个 log。
    // 不绑具体文案：这里要的是「第一行失败后 warn 还能落地」，不是某条前缀。
    let thrown = false
    const logged = []
    const tee = await startTee({
        upstream: upstream.url,
        out,
        log: text => {
            if (!thrown) {
                thrown = true
                throw new Error('stdout 坏了')
            }
            logged.push(String(text))
            return true
        },
    })
    const response = await fetch(`http://127.0.0.1:${tee.address().port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: signRequest(),
    })
    assert.equal(response.status, 200)
    assert.match(logged.join(''), /event=warn/, '默认 warn 没有回落到注入的 log——票八要求的就是这条兜底')
    assert.equal(fs.readFileSync(out, 'utf8').trim().split(/\r?\n/).length, 1, '这一条其实落盘了')
})

test('默认 warn 在 log 自身抛错时不把成功的转发变成 502', async () => {
    const upstream = await listen((request, response) => {
        request.resume()
        request.on('end', () => response.end('{"ok":true}'))
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-warn-')), 'capture.jsonl')
    // log 对每一行都抛，回落分支才真的被执行；退回 stderr 会把一行 event=warn 打到
    // 测试进程的 stderr 上——这是真实行为，不在这里 patch 全局就能看见。
    const tee = await startTee({
        upstream: upstream.url,
        out,
        log: () => {
            throw new Error('stdout 坏了')
        },
    })
    const response = await fetch(`http://127.0.0.1:${tee.address().port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: signRequest(),
    })
    assert.equal(response.status, 200, '终端写坏了不该把调用方晾成 502')
    assert.equal(fs.readFileSync(out, 'utf8').trim().split(/\r?\n/).length, 1, '这一条其实落盘了')
})

test('上游是非回环地址时不许走明文 http：入站拦得住，出站那一跳也得管', () => {
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-up-')), 'capture.jsonl')
    const remote = runTee('--upstream', 'http://10.1.2.3/sign', '--out', outside, '--port', '0')
    assert.notEqual(remote.status, 0)
    assert.match(remote.stderr, /https/, `明文 http 的远端上游照起了：${remote.stderr}`)

    // 「不误杀本机明文上游」判据在同一个纯函数上测：起真服务会一直等信号，不适合拿子进程跑这条
    assert.doesNotThrow(() => assertUpstreamUrl('http://127.0.0.1:8899/sign'), '本机签名器就是明文 http，别拦它')
    assert.doesNotThrow(() => assertUpstreamUrl('http://127.0.0.2:8899/sign'), '127/8 整段都是回环')
    assert.doesNotThrow(() => assertUpstreamUrl('http://[::1]:8899/sign'))
    assert.throws(
        () => assertUpstreamUrl('http://localhost:8899/sign'),
        /https/,
        'localhost 连到哪儿由 hosts 与解析器决定，出站不能把它当回环',
    )
    assert.doesNotThrow(() => assertUpstreamUrl('https://signer.example/sign'), '远端走 https 是文档里给的用法')
    assert.throws(() => assertUpstreamUrl('http://10.1.2.3/sign'), /https/)
    assert.throws(() => assertUpstreamUrl('ftp://127.0.0.1/sign'), /http/)
})

test('上游回跳转时不跟着跑：带 cookie 的请求体不能被重发到别处', async () => {
    const hit = []
    const dest = http.createServer((request, response) => {
        request.resume()
        request.on('end', () => {
            hit.push(request.url)
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end('{}')
        })
    })
    await new Promise(resolve => dest.listen(0, '127.0.0.1', resolve))
    const redirecting = await listen((request, response) => {
        request.resume()
        request.on('end', () => {
            response.writeHead(307, { location: `http://127.0.0.1:${dest.address().port}/stolen` })
            response.end()
        })
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-redirect-')), 'capture.jsonl')
    const tee = await startTee({ upstream: redirecting.url, out, log: () => {} })
    const response = await fetch(`http://127.0.0.1:${tee.address().port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: signRequest(),
    })
    assert.equal(response.status, 502, '跳转不该被默默跟下去，要响')
    assert.equal(hit.length, 0, `请求体被重发到了跳转目的地：${JSON.stringify(hit)}`)
    await new Promise(resolve => dest.close(resolve))
})

test('start() 自己就拒非回环绑定：判据不能只写在命令行那一层', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-bind-')), 'capture.jsonl')
    assert.throws(() => start({ upstream: DEAD_UPSTREAM, host: '0.0.0.0', port: 0, out, log: () => {} }), /回环/)
    assert.throws(() => start({ upstream: DEAD_UPSTREAM, host: '', port: 0, out, log: () => {} }), /回环/)
})

test('start() 自己就拒非回环上传与仓库内落盘：两条直调路径都不能绕过判据', () => {
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-entry-')), 'capture.jsonl')
    assert.throws(
        () => start({ upstream: 'http://10.1.2.3/sign', host: '127.0.0.1', port: 0, out: outside, log: () => {} }),
        /https/,
        '直调 start() 时明文送往非回环上游——判据只写在 main() 里就等于没写',
    )
    assert.throws(
        () =>
            start({
                upstream: DEAD_UPSTREAM,
                host: '127.0.0.1',
                port: 0,
                out: path.join(repoRoot, 'tools', 'capture.jsonl'),
                log: () => {},
            }),
        /不入库/,
        '直调 start() 时把抓包件指进仓库——写入侧没有自己的判据',
    )
})

test('门口拒掉的四种请求各出一行声，并带上收到的值：护栏不出声就等于没有护栏', async () => {
    const logged = []
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-deny-')), 'capture.jsonl')
    const tee = await startTee({ upstream: DEAD_UPSTREAM, out, log: line => logged.push(line) })
    const port = tee.address().port
    await fetch(`http://127.0.0.1:${port}/whatever-not-sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: signRequest() })
    await fetch(`http://127.0.0.1:${port}/sign`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: signRequest() })
    await fetch(`http://127.0.0.1:${port}/sign`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: signRequest() })
    const oversized = await fetch(`http://127.0.0.1:${port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `"${'x'.repeat(256 * 1024)}"`,
    })
    assert.equal(oversized.status, 413, '超过上限的请求体要回 413')

    const text = logged.join('')
    assert.match(text, /event=deny 404/, `路径不符没出声：${JSON.stringify(text)}`)
    assert.match(text, /event=deny 415/, 'content-type 不符没出声')
    assert.match(text, /event=deny 403/, '带 Origin 没出声')
    assert.match(text, /event=deny 413/, '请求体超限没出声——这一格最容易被误读成「中转挂了」')
    // 出声要带上「收到的事实」，否则下一次窗口还是只能猜谁被挡了。
    assert.match(text, /收到 POST \/whatever-not-sign/, `404 没带收到的请求行：${JSON.stringify(text)}`)
    assert.match(text, /收到 text\/plain/, `415 没带收到的 content-type：${JSON.stringify(text)}`)
    assert.match(text, /Origin=http:\/\/evil\.example/, `403 没带收到的 Origin：${JSON.stringify(text)}`)
    assert.ok(!text.includes('SECRET-COOKIE-VALUE'), '出声也不得带出报文内容')
    assert.equal(fs.existsSync(out), false, '四条都不该落盘')
})

test('deny 行把 C1 控制字符压平：Origin 里的 CSI 不能原样进终端', async () => {
    const logged = []
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-c1-')), 'capture.jsonl')
    const tee = await startTee({ upstream: DEAD_UPSTREAM, out, log: line => logged.push(line) })
    const port = tee.address().port
    // fetch 不会把 0x9b 原样发出去；用裸 socket 发一条带 C1 的 Origin（latin1），
    // 模拟「能连到这台中转的任意本机客户端」。0x9b 就是 CSI，有的终端会当转义序列解释。
    await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
            socket.write(
                Buffer.concat([
                    Buffer.from(
                        'POST /sign HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nOrigin: ',
                        'latin1',
                    ),
                    Buffer.from([0x9b, 0x33, 0x31, 0x6d]),
                    Buffer.from('\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', 'latin1'),
                ]),
            )
        })
        socket.on('close', resolve)
        socket.on('error', reject)
        socket.resume()
    })
    const text = logged.join('')
    assert.match(text, /event=deny 403/, `带 C1 的 Origin 没被门口挡下或没出声：${JSON.stringify(text)}`)
    assert.ok(!text.includes('\u009b'), `C1 控制字符原样进了终端：${JSON.stringify(text)}`)
    assert.match(text, /Origin=\?31m/, '只该替换控制字符，收到的其余字节要保留')
})

test('log 抛错也不改口：四种拒绝照样按原状态码回', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-deadlog-')), 'capture.jsonl')
    const tee = await startTee({
        upstream: DEAD_UPSTREAM,
        out,
        log: () => {
            throw new Error('stdout 坏了')
        },
        // 兜底也关掉：这条只看状态码，不让回落到 stderr 的噪声混进来。
        warn: () => {},
    })
    const base = `http://127.0.0.1:${tee.address().port}`
    const statuses = []
    statuses.push(
        (await fetch(`${base}/whatever-not-sign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: signRequest(),
        })).status,
    )
    statuses.push(
        (await fetch(`${base}/sign`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: signRequest() })).status,
    )
    statuses.push(
        (await fetch(`${base}/sign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
            body: signRequest(),
        })).status,
    )
    statuses.push(
        (await fetch(`${base}/sign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: `"${'x'.repeat(256 * 1024)}"`,
        })).status,
    )
    assert.deepEqual(statuses, [404, 415, 403, 413], '日志坏掉把拒绝改成了别的结果')
})

test('复用一份权限更宽的既有抓包件时，写着设备号的那一笔不该以旧权限落地', async t => {
    if (process.platform === 'win32') {
        t.skip('NTFS 不认这个权限位，这条只在 POSIX 上有意义')
        return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-perm-'))
    const out = path.join(dir, 'capture.jsonl')
    fs.writeFileSync(out, '')
    fs.chmodSync(out, 0o666) // 一份本来就谁都能读的旧文件
    const modesAtWrite = []
    // 这里 patch 的是全局 `fs` 对象：工具与用例 import 的是同一个模块实例，
    // `appendRecord()` 里的 `fs.writeSync` 才会走到这个桩上。这条耦合是故意的——
    // 换成为工具注入 fs 就不成立，改动 appendRecord 的写法时记得这条用例靠的是它。
    const originalWrite = fs.writeSync
    fs.writeSync = function patched(fd, ...rest) {
        try {
            modesAtWrite.push(fs.fstatSync(fd).mode & 0o777)
        } catch {
            // 观察失败不影响写入本身
        }
        return originalWrite.call(fs, fd, ...rest)
    }
    try {
        const tee = await startTee({ upstream: DEAD_UPSTREAM, out, log: () => {} })
        await fetch(`http://127.0.0.1:${tee.address().port}/sign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: signRequest(),
        })
    } finally {
        fs.writeSync = originalWrite
    }
    assert.ok(modesAtWrite.length > 0, '这一笔写没发生，测不出权限')
    assert.deepEqual([...new Set(modesAtWrite)], [0o600], '写下那一刻文件权限还是宽的——先定权限再写')
    assert.equal(fs.statSync(out).mode & 0o777, 0o600)
})

test('终端那行的标签要对得上它数的东西：是全部头名，不是 UA 相关', () => {
    const line = formatCapture(
        captureRecord({
            url: TRACK_V2_URL,
            headers: { Cookie: SECRET_COOKIE, 'user-agent': 'LunaPC/3.3.0(359450208)', 'x-ss-stub': 'A' },
        }).record,
    )
    assert.match(line, /头名=3条/, `标签名不副实：${line}`)
    assert.ok(!line.includes('UA头'), '这个数是全部头名，跟 UA 没关系——真机是 7 个里头只有 1 个 UA')
})

test('身份不齐那条走真中转：一个字不落盘，但终端要有一行说清缺什么', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-skip-')), 'capture.jsonl')
    const logged = []
    const tee = await startTee({ upstream: DEAD_UPSTREAM, out, log: line => logged.push(line) })
    const incomplete = JSON.stringify({
        url: 'https://api.qishui.com/luna/pc/track_v2?device_id=1789435000000&fp=1789435000000',
        method: 'POST',
        body: '{"track_id":"123"}',
        ts_ms: 1789435000000,
        headers: { cookie: SECRET_COOKIE },
    })
    await fetch(`http://127.0.0.1:${tee.address().port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: incomplete,
    })
    assert.equal(fs.existsSync(out), false, '缺 iid 的那条一个字都不该落盘')
    const text = logged.join('')
    assert.match(text, /event=skip/, '带着设备号却身份不齐，要出声')
    assert.match(text, /缺 iid \/ fp/, '要说清是身份不齐，不是解析不了')
    assert.ok(!text.includes('SECRET-COOKIE-VALUE'), '出声也不得带出 cookie 值')
})
