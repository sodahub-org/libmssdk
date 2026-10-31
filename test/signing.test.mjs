// 离线测试：契约、签名覆盖范围、HTTP 服务、鉴权、/probe 判定逻辑。
// 用 mock-bdms 代替真实的 bdms.node，因此在 Linux/CI 上也能跑。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const { rawExchange } = await import('./helpers/raw-request.mjs')

const here = path.dirname(fileURLToPath(import.meta.url))
const mockBdms = path.join(here, 'fixtures', 'mock-bdms.mjs')

process.env.LIBMSSDK_BDMS_MODULE = mockBdms
process.env.LIBMSSDK_DEVICE_ID = '7000000000000001'
process.env.LIBMSSDK_TOKEN = 'test-token'
process.env.LIBMSSDK_PORT = '0'
process.env.LIBMSSDK_BIND = '127.0.0.1'

const { BdmsSigner, flattenHeaders, parseSignaturePairs } = await import('../src/bdms.mjs')
const { normalizeSignRequest, ValidationError } = await import('../src/contract.mjs')
const { buildTrackV2Request, fetchTrackV2, probeTrack, summarizeTrackV2Response } = await import('../src/probe.mjs')
const { bundledNative, loadConfig, resolveIdentity } = await import('../src/config.mjs')
const { randomDeviceId } = await import('../src/identity.mjs')
const { workerEnvFor } = await import('../src/serve.mjs')

let server
let baseUrl
let createServer

before(async () => {
    createServer = (await import('../src/server.mjs')).createServer
    const config = loadConfig()
    const signer = new BdmsSigner({ modulePath: config.bdmsModule, deviceId: config.deviceId })
    server = createServer({ config, signer })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(() => new Promise(resolve => server.close(resolve)))

test('flattenHeaders 与官方约定一致（k\r\nv 成对）', () => {
    const lines = flattenHeaders({ 'user-agent': 'LunaPC/1', cookie: 'a=b' })
    assert.equal(lines, 'user-agent\r\nLunaPC/1\r\ncookie\r\na=b')
    assert.deepEqual(parseSignaturePairs('X-Helios\r\nh\r\nX-Medusa\r\nm'), {
        'X-Helios': 'h',
        'X-Medusa': 'm',
    })
})

test('签名覆盖 URL 与请求头（改一个字节签名就变）', () => {
    const signer = new BdmsSigner({ modulePath: mockBdms, deviceId: '7000000000000001' })
    const base = signer.sign({
        url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088',
        headers: { 'x-ss-stub': 'AAA', cookie: 'sid=1' },
    })
    const otherBody = signer.sign({
        url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088',
        headers: { 'x-ss-stub': 'BBB', cookie: 'sid=1' },
    })
    const otherUrl = signer.sign({
        url: 'https://api.qishui.com/luna/pc/track_v2?aid=386089',
        headers: { 'x-ss-stub': 'AAA', cookie: 'sid=1' },
    })
    assert.match(base.headers['X-Helios'] || base.headers['x-helios'], /mock-helios-/)
    assert.notEqual(base.headers['X-Medusa'], otherBody.headers['X-Medusa'])
    assert.notEqual(base.headers['X-Helios'], otherUrl.headers['X-Helios'])
})

test('normalizeSignRequest 校验 url / headers', () => {
    assert.throws(() => normalizeSignRequest({}), ValidationError)
    assert.throws(() => normalizeSignRequest({ url: 'ftp://x' }), ValidationError)
    const spec = normalizeSignRequest({ url: 'https://api.qishui.com/x', headers: { a: 1 } })
    assert.equal(spec.method, 'POST')
    assert.equal(spec.headers.a, '1')
})

test('buildTrackV2Request 生成官方形态的 URL 与 X-SS-STUB', () => {
    const spec = buildTrackV2Request({ trackId: '7501674235158431760', deviceId: '7000000000000001' })
    assert.match(spec.url, /^https:\/\/api\.qishui\.com\/luna\/pc\/track_v2\?/)
    assert.match(spec.url, /device_id=7000000000000001/)
    assert.match(spec.url, /app_name=luna_pc/)
    assert.equal(spec.headers['x-ss-stub'].length, 32)
    assert.equal(spec.headers['x-ss-stub'], spec.headers['x-ss-stub'].toUpperCase())
})

// 上游调用整票收敛到这一个函数：HTTP 层（src/endpoints.mjs、src/dispatcher.mjs）不再有任何
// 接受外部输入去打上游的入口，只有命令行 probe 经这里出去。
test('fetchTrackV2 打一次上游，只把状态与正文交回调用方', async () => {
    const calls = []
    const { status, text } = await fetchTrackV2({
        url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088',
        body: '{"track_id":"7501674235158431760"}',
        headers: { 'x-ss-stub': 'ABC', cookie: 'sid=1' },
        timeoutMs: 1234,
        fetchImpl: async (url, init) => {
            calls.push({ url, init })
            return new Response('upstream-body', { status: 200 })
        },
    })
    assert.equal(status, 200)
    assert.equal(text, 'upstream-body')
    assert.equal(calls.length, 1, '一次调用只打一次上游')
    assert.equal(calls[0].url, 'https://api.qishui.com/luna/pc/track_v2?aid=386088')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.body, '{"track_id":"7501674235158431760"}')
    assert.equal(calls[0].init.headers.cookie, 'sid=1', 'Cookie 原样发出去：签名覆盖全部请求头')
    assert.ok(calls[0].init.signal, '必须带超时信号，否则挂住的上游会把命令行吊死在这里')
})

test('probeTrack 把签名头发完再打上游，交回的是 http 与判定', async () => {
    const signer = new BdmsSigner({ modulePath: mockBdms, deviceId: '7000000000000001' })
    const payload = JSON.stringify({
        track: { id: '7501674235158431760', name: '下完这场雨', duration: 236620 },
        track_player: {
            video_model: JSON.stringify({
                video_duration: 236.62,
                video_list: [
                    { gear_des_key: '0:M4A|1:audio_encrypt|2:aac|5:highest', video_meta: { quality: 'highest', bitrate: 260286, size: 4408084 } },
                    { gear_des_key: '0:MP4|1:audio_encrypt|2:flac|5:lossless', video_meta: { quality: 'lossless', bitrate: 1741286, size: 46275289 } },
                ],
            }),
        },
    })
    let sent
    const report = await probeTrack({
        signer,
        trackId: '7501674235158431760',
        deviceId: '7000000000000001',
        cookie: 'sessionid_ss=caller-cookie',
        timeoutMs: 5000,
        fetchImpl: async (url, init) => {
            sent = { url, init }
            return new Response(payload, { status: 200 })
        },
    })
    assert.equal(report.http, 200)
    assert.equal(report.summary.fullTrack, true)
    assert.equal(report.summary.gears.length, 2)
    assert.equal(report.summary.bestGear.quality, 'lossless')
    assert.equal(report.deviceId, '7000000000000001', '签名用的就是这一次的设备号')
    // 这三样都是一路带上请求的：少了任何一个，上游给的就是「HTTP 200 + 0 字节」
    assert.match(sent.init.headers['X-Helios'], /mock-helios-/)
    assert.match(sent.init.headers['X-Medusa'], /mock-medusa-/)
    assert.equal(sent.init.headers.cookie, 'sessionid_ss=caller-cookie')
    assert.match(sent.url, /device_id=7000000000000001/, 'URL 里的设备号与签名器同一份')
})

test('summarizeTrackV2Response 区分整曲与试听', () => {
    const full = summarizeTrackV2Response(
        JSON.stringify({
            track: { id: '1', name: '整曲', duration: 236620 },
            track_player: {
                video_model: JSON.stringify({
                    video_duration: 236.62,
                    video_list: [{ gear_des_key: '0:MP4|1:audio_encrypt|2:flac|5:lossless', video_meta: { quality: 'lossless', bitrate: 1741286, size: 46275289 } }],
                }),
            },
        }),
        '1',
    )
    assert.equal(full.accepted, true)
    assert.equal(full.fullTrack, true)
    assert.equal(full.bestGear.quality, 'lossless')

    const preview = summarizeTrackV2Response('', '1')
    assert.equal(preview.accepted, false)
    assert.match(preview.hint, /空响应/)
})

test('试听的提示不再把设备号列成原因（#10 实测：同一份设备号在别的曲目能拿整曲）', () => {
    const previewOnly = summarizeTrackV2Response(
        JSON.stringify({
            track: { id: '1', name: '试听级', duration: 278507 },
            track_player: {
                video_model: JSON.stringify({
                    video_duration: 60,
                    video_list: [{ gear_des_key: '0:M4A|5:higher', video_meta: { quality: 'higher', bitrate: 132180, size: 3061783 } }],
                }),
            },
        }),
        '1',
    )
    assert.equal(previewOnly.fullTrack, false)
    assert.match(previewOnly.hint, /设备号不是变量/)
    assert.ok(!/设备指纹不匹配/.test(previewOnly.hint), `提示里不该再有设备指纹归因：${previewOnly.hint}`)
    assert.ok(!/该账号就是/.test(previewOnly.hint), '账号权益本次没测出来，提示里不该断言')
})

test('POST /sign 返回 X-Helios / X-Medusa（含鉴权）', async () => {
    const unauthorized = await fetch(`${baseUrl}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://api.qishui.com/luna/pc/track_v2' }),
    })
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).code, 'UNAUTHORIZED', '老路径与默认路径用同一个原因码')

    const response = await fetch(`${baseUrl}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({
            url: 'https://api.qishui.com/luna/pc/track_v2?device_id=7000000000000001',
            method: 'POST',
            body: '{"track_id":"1"}',
            headers: { 'x-ss-stub': 'ABC', cookie: 'sid=1' },
        }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.ok(payload.headers['X-Helios'])
    assert.ok(payload.headers['X-Medusa'])
})

test('GET /healthz 不泄露凭据', async () => {
    const response = await fetch(`${baseUrl}/healthz`)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.auth, true)
    assert.equal(payload.deviceId, '700***001')
    assert.equal(JSON.stringify(payload).includes('7000000000000001'), false)
})

// 过渡端点处理器上同一条防线：解析函数与分发器共用，行为也得一样。
// 修复前 handler 里的 `new URL()` 一抛就是 unhandled rejection（Node 15+ 直接退进程），
// 一条匿名 `GET //` 就能把服务带走 —— 所以这里断言的是「进程还在、后面的请求还通」。
test('畸形请求目标与畸形 Host 不会退掉进程', async () => {
    const port = server.address().port

    const malformed = await rawExchange(port, { requestLine: 'GET //' })
    assert.equal(malformed.error, null, `连接不该被重置：${malformed.error?.code || ''}`)
    assert.match(malformed.text, /^HTTP\/1\.1 404 /, '畸形目标按「没这条路由」处理')

    const badHost = await rawExchange(port, { requestLine: 'GET /healthz', headers: { host: 'a b' } })
    assert.match(badHost.text, /^HTTP\/1\.1 200 /, 'Host 不参与解析：健康检查照旧')
    assert.match(badHost.text, /"ok":true/)
})

test('GET /healthz 在 worker 预热完成前回 503，就绪后才回 200', async () => {
    let ready = false
    const config = loadConfig()
    const signer = new BdmsSigner({ modulePath: config.bdmsModule, deviceId: config.deviceId })
    const gated = createServer({ config, signer, readiness: () => ready })
    await new Promise(resolve => gated.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${gated.address().port}/healthz`
    try {
        const warming = await fetch(url)
        assert.equal(warming.status, 503, '预热未完成时不能让编排器以为已就绪')
        assert.equal((await warming.json()).ready, false)

        ready = true
        const serving = await fetch(url)
        assert.equal(serving.status, 200)
        assert.equal((await serving.json()).ready, true)
    } finally {
        await new Promise(resolve => gated.close(resolve))
    }
})

test('老路径非法 JSON 也按 400 INVALID_REQUEST 收口，不是 500', async () => {
    const response = await fetch(`${baseUrl}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: '{"url":',
    })
    assert.equal(response.status, 400)
    const payload = await response.json()
    assert.equal(payload.code, 'INVALID_REQUEST')
    assert.match(payload.error, /不是合法 JSON/)
})

test('老路径请求体超限也回可读的 400，而不是连接重置', async () => {
    const config = { ...loadConfig(), maxBodyBytes: 64 }
    const signer = new BdmsSigner({ modulePath: config.bdmsModule, deviceId: config.deviceId })
    const capped = createServer({ config, signer })
    await new Promise(resolve => capped.listen(0, '127.0.0.1', resolve))
    try {
        const response = await fetch(`http://127.0.0.1:${capped.address().port}/sign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
            body: JSON.stringify({ url: 'https://api.qishui.com/x', body: 'x'.repeat(4096) }),
        })
        assert.equal(response.status, 400)
        assert.equal((await response.json()).code, 'INVALID_REQUEST')
    } finally {
        await new Promise(resolve => capped.close(resolve))
    }
})

test('POST /probe 上游非 200 不再回 502：按内部错误收口并保留诊断字段', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('', { status: 403 })
    try {
        const response = await originalFetch(`${baseUrl}/probe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
            body: JSON.stringify({ track_id: '7501674235158431760' }),
        })
        assert.equal(response.status, 500)
        const payload = await response.json()
        assert.equal(payload.code, 'INTERNAL_ERROR')
        assert.equal(payload.http, 403, '上游状态码仍留在诊断字段里')
        assert.equal(response.headers.get('retry-after'), null)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('签名器内部抛错也不再回 502：老路径同样按 INTERNAL_ERROR 收口', async () => {
    const config = loadConfig()
    const broken = createServer({
        config,
        signer: {
            available: true,
            deviceId: config.deviceId,
            sign() {
                throw new Error('原生模块炸了')
            },
        },
    })
    await new Promise(resolve => broken.listen(0, '127.0.0.1', resolve))
    try {
        const response = await fetch(`http://127.0.0.1:${broken.address().port}/sign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
            body: JSON.stringify({ url: 'https://api.qishui.com/luna/pc/track_v2' }),
        })
        assert.equal(response.status, 500)
        const payload = await response.json()
        assert.equal(payload.code, 'INTERNAL_ERROR')
        assert.match(payload.error, /原生模块炸了/)
    } finally {
        await new Promise(resolve => broken.close(resolve))
    }
})

test('POST /probe 命中整曲时返回完整档位', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
        new Response(
            JSON.stringify({
                track: { id: '7501674235158431760', name: '下完这场雨', duration: 236620 },
                track_player: {
                    video_model: JSON.stringify({
                        video_duration: 236.62,
                        video_list: [
                            { gear_des_key: '0:M4A|1:audio_encrypt|2:aac|5:highest', video_meta: { quality: 'highest', bitrate: 260286, size: 4408084 } },
                            { gear_des_key: '0:MP4|1:audio_encrypt|2:flac|5:lossless', video_meta: { quality: 'lossless', bitrate: 1741286, size: 46275289 } },
                        ],
                    }),
                },
            }),
            { status: 200 },
        )
    try {
        // 注意：用保留的 originalFetch 调本机服务，否则会被上面的桩拦掉
        const response = await originalFetch(`${baseUrl}/probe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
            body: JSON.stringify({ track_id: '7501674235158431760' }),
        })
        const payload = await response.json()
        assert.equal(payload.fullTrack, true)
        assert.equal(payload.gears.length, 2)
        assert.equal(payload.bestGear.quality, 'lossless')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('身份只在内存里时，主进程把已解析的设备号交给 worker', () => {
    const env = { PATH: 'x' }
    assert.deepEqual(workerEnvFor({ identityPersisted: false, deviceId: '7000000000000001' }, env), {
        PATH: 'x',
        LIBMSSDK_DEVICE_ID: '7000000000000001',
    })
    assert.equal(
        workerEnvFor({ identityPersisted: true, deviceId: '7000000000000001' }, env),
        env,
        '落盘成功时仍让 worker 只读身份文件',
    )
    assert.equal(workerEnvFor({ identityPersisted: false, deviceId: '' }, env), env, '没有设备号就不要伪造一个')
})

test('原生模块默认不随仓库提供，必须由用户配置', () => {
    const savedModule = process.env.LIBMSSDK_BDMS_MODULE
    const savedClient = process.env.LIBMSSDK_CLIENT_DIR
    delete process.env.LIBMSSDK_BDMS_MODULE
    delete process.env.LIBMSSDK_CLIENT_DIR
    try {
        const local = bundledNative()
        const config = loadConfig()
        assert.equal(local.modulePath, '')
        assert.equal(local.libraryPath, '')
        assert.equal(config.bundledBdms, '')
    } finally {
        if (savedModule !== undefined) process.env.LIBMSSDK_BDMS_MODULE = savedModule
        if (savedClient !== undefined) process.env.LIBMSSDK_CLIENT_DIR = savedClient
    }
})

test('设备指纹：随机生成、落盘复用、可被环境变量覆盖', () => {
    const savedDevice = process.env.LIBMSSDK_DEVICE_ID
    const savedStateDir = process.env.LIBMSSDK_STATE_DIR
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-identity-'))
    delete process.env.LIBMSSDK_DEVICE_ID
    process.env.LIBMSSDK_STATE_DIR = dir
    try {
        const first = resolveIdentity()
        assert.match(first.deviceId, /^[1-8]\d{15}$/, '设备号应为 16 位数字且首位 1-8')
        assert.match(first.iid, /^[1-8]\d{15}$/)
        assert.equal(first.fp, first.deviceId)
        assert.equal(first.source, 'state')
        assert.equal(first.created, true, '首次运行应由本进程独占创建身份文件')
        assert.equal(first.persisted, true)
        assert.ok(fs.existsSync(path.join(dir, 'identity.json')))

        // 再次解析（等价于服务重启）必须复用同一个设备号
        const second = resolveIdentity()
        assert.equal(second.deviceId, first.deviceId)
        assert.equal(second.iid, first.iid)
        assert.equal(second.created, false, '已有身份文件时不该再生成')

        // 环境变量优先级最高，且不写 state 文件
        process.env.LIBMSSDK_DEVICE_ID = '7000000000000001'
        const overridden = resolveIdentity()
        assert.equal(overridden.deviceId, '7000000000000001')
        assert.equal(overridden.source, 'env')
        delete process.env.LIBMSSDK_DEVICE_ID
        assert.equal(resolveIdentity().deviceId, first.deviceId)
    } finally {
        if (savedDevice !== undefined) process.env.LIBMSSDK_DEVICE_ID = savedDevice
        if (savedStateDir === undefined) delete process.env.LIBMSSDK_STATE_DIR
        else process.env.LIBMSSDK_STATE_DIR = savedStateDir
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('randomDeviceId 生成合法且不重复', () => {
    const ids = new Set()
    for (let index = 0; index < 200; index += 1) {
        const id = randomDeviceId()
        assert.match(id, /^[1-8]\d{15}$/)
        ids.add(id)
    }
    assert.equal(ids.size, 200)
})
