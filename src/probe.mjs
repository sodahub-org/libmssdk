// 真机自检：签一次名、打一次真实接口，判断"到底拿到试听还是整曲"。
//
// 这是部署完服务后最有用的一条命令 —— 只看 /sign 返回 200 说明不了问题，
// 因为服务端对签名不对的请求会回 `HTTP 200 + 0 字节`（我们踩过这个坑）。
//
// src/ 里向外发请求的代码只有这一处（fetchTrackV2）：入口只有命令行 `probe` 与手动验证脚本，
// #9 之后 HTTP 层不再有任何拿调用方输入打上游的路径（test/endpoints.test.mjs 有结构守卫）。
// tools/ 下那份对照实验脚本自己构造请求是另一回事：它要的是与本机服务不同的请求形状，故意不合并。

import crypto from 'node:crypto'

const DEFAULT_UA = 'LunaPC/3.8.0(467160162)'

export function buildTrackV2Request({
    trackId,
    deviceId,
    iid = '',
    fp = '',
    userAgent = DEFAULT_UA,
    cookie = '',
    queueType = 'favorite_track_playlist',
    sceneName = 'library',
    versionName = '3.8.0',
    versionCode = '30080000',
    osVersion = 'Windows 11',
}) {
    if (!trackId) throw new Error('track_id 不能为空')
    if (!deviceId) throw new Error('device_id 不能为空（必须与签名器同设备）')
    const body = JSON.stringify({
        track_id: String(trackId),
        media_type: 'track',
        queue_type: queueType,
        scene_name: sceneName,
    })
    const query = new URLSearchParams({
        aid: '386088',
        app_name: 'luna_pc',
        region: 'cn',
        geo_region: 'cn',
        os_region: 'cn',
        sim_region: '',
        device_id: String(deviceId),
        cdid: '',
        iid: String(iid || ''),
        version_name: versionName,
        version_code: versionCode,
        channel: 'official',
        build_mode: 'master',
        network_carrier: '',
        ac: 'wifi',
        tz_name: 'Asia/Shanghai',
        resolution: '',
        device_platform: 'windows',
        device_type: 'Windows',
        os_version: osVersion,
        fp: String(fp || deviceId),
    })
    const url = `https://api.qishui.com/luna/pc/track_v2?${query.toString()}`
    const traceId = `00-${crypto.randomBytes(8).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`
    const headers = {
        'content-type': 'application/json; charset=utf-8',
        'user-agent': userAgent,
        'x-luna-background-type': 'foreground',
        'x-luna-is-background-req': '0',
        'x-luna-is-local-user': '0',
        'x-tt-trace-id': traceId,
        'x-ss-stub': crypto.createHash('md5').update(body).digest('hex').toUpperCase(),
        'accept-encoding': 'gzip, deflate',
    }
    if (cookie) headers.cookie = cookie
    return { url, method: 'POST', body, headers }
}

/**
 * 打一次 track_v2 上游：全仓库唯一向外发请求的地方。
 *
 * 只回 `{status, text}`，判定交给 summarizeTrackV2Response —— 命令行与手动验证脚本共用同一条
 * 出网路径，别让人再给 HTTP 层加一条「顺便帮我打个上游」的路由。
 */
export async function fetchTrackV2({ url, body, headers, timeoutMs, fetchImpl = globalThis.fetch }) {
    const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: response.status, text: await response.text() }
}

/**
 * 一次真机自检：签名 → 打上游 → 汇总。命令行 `probe` 只负责拼参数和打印。
 *
 * 签名器与 fetch 都从参数进来：这条链路要能在没有原生模块、没有网络的用例里跑完整，
 * 也顺手保证「出网只此一处」——想加第二条的人得先经过这里。
 */
export async function probeTrack({ signer, trackId, deviceId, iid = '', fp = '', cookie = '', timeoutMs, fetchImpl }) {
    const spec = buildTrackV2Request({ trackId, deviceId, iid, fp, cookie })
    const signed = signer.sign({ url: spec.url, headers: spec.headers, deviceId })
    const upstream = await fetchTrackV2({
        url: spec.url,
        body: spec.body,
        headers: { ...spec.headers, ...signed.headers },
        timeoutMs,
        fetchImpl,
    })
    return { http: upstream.status, deviceId: signed.deviceId, summary: summarizeTrackV2Response(upstream.text, trackId) }
}

/** 汇总服务端回包：整曲还是试听、有哪些档位。 */
export function summarizeTrackV2Response(rawBody, trackId) {
    const text = String(rawBody || '')
    if (!text.trim()) {
        return {
            ok: false,
            accepted: false,
            bodyBytes: 0,
            hint: '空响应：签名没被接受（检查 device_id 是否与签名器同设备、headers 是否与实际发送一致）',
        }
    }
    let payload
    try {
        payload = JSON.parse(text)
    } catch {
        return { ok: false, accepted: false, bodyBytes: text.length, hint: '响应不是 JSON' }
    }
    const track = payload.track || payload.track_info || {}
    const player = payload.track_player || {}
    let videoModel = player.video_model
    if (typeof videoModel === 'string') {
        try {
            videoModel = JSON.parse(videoModel)
        } catch {
            videoModel = null
        }
    }
    const gears = ((videoModel && videoModel.video_list) || []).map(item => ({
        gear: item.gear_des_key || '',
        quality: item?.video_meta?.quality || '',
        codec: item?.video_meta?.codec_type || '',
        bitrate: item?.video_meta?.bitrate || 0,
        size: item?.video_meta?.size || 0,
    }))
    const trackDurationMs = Number(track.duration) || 0
    const streamDuration = Number((videoModel && videoModel.video_duration) || 0)
    const fullTrack = trackDurationMs > 0 && streamDuration * 1000 + 2000 >= trackDurationMs
    const best = gears.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] || null
    return {
        ok: true,
        accepted: true,
        bodyBytes: text.length,
        trackId: track.id || String(trackId || ''),
        name: track.name || '',
        trackDurationSeconds: trackDurationMs / 1000,
        streamDurationSeconds: streamDuration,
        fullTrack,
        gears,
        bestGear: best,
        hint: fullTrack
            ? `整曲（${gears.length} 档${best ? `，最高 ${best.quality || best.gear} ${Math.round((best.bitrate || 0) / 1000)}kbps` : ''}）`
            : '只拿到试听片段：同一份设备号在别的曲目上能拿到整曲，所以设备号不是变量；这首曲子在当前凭据下只有试听档',
    }
}
