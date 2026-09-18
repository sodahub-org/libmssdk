// 离线测试：契约、签名覆盖范围、HTTP 服务、鉴权、/probe 判定逻辑。
// 用 mock-bdms 代替真实的 bdms.node，因此在 Linux/CI 上也能跑。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const mockBdms = path.join(here, 'fixtures', 'mock-bdms.mjs')

process.env.LIBMSSDK_BDMS_MODULE = mockBdms
process.env.LIBMSSDK_DEVICE_ID = '7000000000000001'
process.env.LIBMSSDK_TOKEN = 'test-token'
process.env.LIBMSSDK_PORT = '0'
process.env.LIBMSSDK_BIND = '127.0.0.1'

const { BdmsSigner, flattenHeaders, parseSignaturePairs } = await import('../src/bdms.mjs')
const { normalizeSignRequest, ValidationError } = await import('../src/contract.mjs')
const { buildTrackV2Request, summarizeTrackV2Response } = await import('../src/probe.mjs')
const { bundledNative, loadConfig, randomDeviceId, resolveIdentity } = await import('../src/config.mjs')

let server
let baseUrl

before(async () => {
    const { createServer } = await import('../src/server.mjs')
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

test('POST /sign 返回 X-Helios / X-Medusa（含鉴权）', async () => {
    const unauthorized = await fetch(`${baseUrl}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://api.qishui.com/luna/pc/track_v2' }),
    })
    assert.equal(unauthorized.status, 401)

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
        assert.equal(first.persisted, true)
        assert.ok(fs.existsSync(path.join(dir, 'identity.json')))

        // 再次解析（等价于服务重启）必须复用同一个设备号
        const second = resolveIdentity()
        assert.equal(second.deviceId, first.deviceId)
        assert.equal(second.iid, first.iid)

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
