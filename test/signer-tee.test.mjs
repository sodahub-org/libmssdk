// 取证中转的离线用例：它站在「已登录播放器」与「签名服务」中间，
// 唯一的职责是把播放器真实发出的设备身份记进一份 0600 的抓包件，其余一律原样转发。
// 断言的都是外部可见的事实（转发出去的内容、落盘的那几行、回给调用方的状态码），
// 以及一条边界：凭据既不落盘也不回显。全部走 listen(0)，不打网络。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const { assertOutsideRepo, captureRecord, formatCapture, start } = await import('../tools/signer-tee.mjs')

const SECRET_COOKIE = 'sessionid_ss=SECRET-COOKIE-VALUE'
const SECRET_TOKEN = 'Bearer SECRET-TOKEN-VALUE'
/** 播放器真实发出去的那一份设备身份（本机就是每请求一个毫秒时间戳）。 */
const CAPTURED_ID = { deviceId: '1789435000000', iid: '1789435000001', fp: '1789435000000' }
const TRACK_V2_URL =
    'https://api.qishui.com/luna/pc/track_v2?ac=wifi&aid=386088&device_id=1789435000000&fp=1789435000000' +
    '&iid=1789435000001&os_version=Windows+11&region=cn&tz_name=Asia+Shanghai&version_code=30030000&version_name=3.3.0'

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

test('抓到的是播放器真实发出的那一份设备身份，形状字段一起留下', () => {
    const record = captureRecord({
        url: TRACK_V2_URL,
        method: 'POST',
        tsMs: 1789435000000,
        headers: { Cookie: SECRET_COOKIE, 'user-agent': 'LunaPC/3.3.0(359450208)', 'X-Luna-Is-Local-User': '1' },
    })
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
    })
    const text = JSON.stringify(record)
    assert.ok(!text.includes('SECRET-COOKIE-VALUE'), 'cookie 值不得进抓包件')
    assert.ok(!text.includes('SECRET-HELIOS'), '签名值不得进抓包件')
    assert.ok(!text.includes('SECRET-MEDUSA'), '签名值不得进抓包件')
    assert.ok(!text.includes('SECRET-TOKEN-VALUE'), '令牌不得进抓包件')
    assert.ok(text.includes('authorization'), '但头名要留：它是要复刻的请求形状的一部分')
    assert.equal(record.cookieFields, 1)
})

test('没有 device_id 的请求不算一份身份，坏 URL 也不炸', () => {
    assert.equal(captureRecord({ url: 'https://api.qishui.com/luna/pc/me?iid=1' }), null)
    assert.equal(captureRecord({ url: 'not a url' }), null)
    assert.equal(captureRecord({ url: '' }), null)
})

test('打到终端的那一行只留首尾：完整设备号不进日志', () => {
    const line = formatCapture(captureRecord({ url: TRACK_V2_URL }))
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
    return { server, port: server.address().port }
}
/** 一个确定没人听的端口：先占住再放开，比写死端口号可靠。 */
async function closedPort() {
    const server = http.createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    return port
}
/** 起一台中转，指向上面那个假上游。 */
async function startTee({ upstreamPort, out, log = () => {} }) {
    const tee = await start({
        upstream: `http://127.0.0.1:${upstreamPort}/sign`,
        host: '127.0.0.1',
        port: 0,
        out,
        log,
    })
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
    const tee = await startTee({ upstreamPort: upstream.port, out, log: line => logged.push(line) })
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

    // 上游没人听时报 502，且报文里不带本机/上游细节。
    const deadOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-')), 'dead.jsonl')
    const deadTee = await startTee({ upstreamPort: await closedPort(), out: deadOut, log: line => logged.push(line) })
    const dead = await fetch(`http://127.0.0.1:${deadTee.address().port}/sign`, { method: 'POST', body: signRequest() })
    assert.equal(dead.status, 502)
    const deadText = await dead.text()
    assert.ok(!deadText.includes('127.0.0.1'), `报错漏出了上游地址：${deadText}`)
    assert.match(logged.join(''), /event=tee/, '打出去的那一行是脱敏读数')
    assert.ok(!logged.join('').includes('1789435000000'), '终端那一行不带完整设备号')
})

test('非 POST 不记录也不转发，坏 JSON 只转发不记录', async () => {
    let hits = 0
    const upstream = await listen((request, response) => {
        hits += 1
        request.resume()
        request.on('end', () => response.end('{"ok":true}'))
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-')), 'capture.jsonl')
    const tee = await startTee({ upstreamPort: upstream.port, out })
    const base = `http://127.0.0.1:${tee.address().port}/sign`

    const wrongMethod = await fetch(base, { method: 'GET' })
    assert.equal(wrongMethod.status, 404)
    assert.equal(hits, 0, 'GET 不该被转发')

    const garbage = await fetch(base, { method: 'POST', body: 'not json at all' })
    assert.equal(garbage.status, 200, '解析不了照样转发：记录是顺带的事')
    assert.equal(hits, 1)
    assert.equal(fs.existsSync(out), false, '坏 JSON 里没有身份，抓包件不该被创建')
})

test('没有 device_id 的请求转发但不进抓包件', async () => {
    const upstream = await listen((request, response) => {
        request.resume()
        request.on('end', () => response.end('{"ok":true}'))
    })
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-tee-')), 'capture.jsonl')
    const tee = await startTee({ upstreamPort: upstream.port, out })
    const response = await fetch(`http://127.0.0.1:${tee.address().port}/sign`, {
        method: 'POST',
        body: JSON.stringify({ ...JSON.parse(signRequest()), url: 'https://api.qishui.com/luna/pc/me?iid=1' }),
    })
    assert.equal(response.status, 200)
    assert.equal(fs.existsSync(out), false)
})

test('绑定只认回环：非回环地址直接拒绝启动', async () => {
    const { isLoopbackBind } = await import('../src/dispatch.mjs')
    assert.equal(isLoopbackBind('127.0.0.1'), true)
    assert.equal(isLoopbackBind('::1'), true)
    assert.equal(isLoopbackBind('0.0.0.0'), false)
    assert.equal(isLoopbackBind('10.0.0.5'), false)
})
