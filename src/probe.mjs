// 真机自检：签一次名、打一次真实接口，判断"到底拿到试听还是整曲"。
//
// 这是部署完服务后最有用的一条命令 —— 只看 /sign 返回 200 说明不了问题，
// 因为服务端对签名不对的请求会回 `HTTP 200 + 0 字节`（我们踩过这个坑）。

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
            : '只拿到试听片段：账号无该曲目整曲权益，或签名/设备指纹不匹配',
    }
}
