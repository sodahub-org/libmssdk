// 离线单元测试：签名覆盖范围、契约校验、上游请求（只有 src/probe.mjs 这一处）、配置与身份。
// 用 mock-bdms 代替真实的 bdms.node，因此在 Linux/CI 上也能跑。
//
// HTTP 那一层不在这里：端点行为见 test/endpoints.test.mjs，排队与错误码见 test/dispatcher.test.mjs，
// 真进程装配见 test/pool-process.test.mjs。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const mockBdms = path.join(here, 'fixtures', 'mock-bdms.mjs')

process.env.LIBMSSDK_BDMS_MODULE = mockBdms
process.env.LIBMSSDK_DEVICE_ID = '7000000000000001'

const { BdmsSigner, flattenHeaders, parseSignaturePairs } = await import('../src/bdms.mjs')
const { normalizeSignRequest, ValidationError } = await import('../src/contract.mjs')
const { buildTrackV2Request, fetchTrackV2, probeTrack, summarizeTrackV2Response } = await import('../src/probe.mjs')
const { bundledNative, loadConfig, resolveIdentity } = await import('../src/config.mjs')
const { randomDeviceId } = await import('../src/identity.mjs')
const { workerEnvFor } = await import('../src/serve.mjs')

const fullTrackPayload = JSON.stringify({
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
    let sent
    const report = await probeTrack({
        signer,
        trackId: '7501674235158431760',
        deviceId: '7000000000000001',
        cookie: 'sessionid_ss=caller-cookie',
        timeoutMs: 5000,
        fetchImpl: async (url, init) => {
            sent = { url, init }
            return new Response(fullTrackPayload, { status: 200 })
        },
    })
    assert.equal(report.http, 200)
    assert.equal(report.summary.fullTrack, true)
    assert.equal(report.summary.gears.length, 2)
    assert.equal(report.summary.bestGear.quality, 'lossless')
    assert.equal(report.deviceId, '7000000000000001', '签名用的就是这一次的设备号')
    // 这三样都是从签名器一路带上请求的：少了任何一个，上游给的就是「HTTP 200 + 0 字节」
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
