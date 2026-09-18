# 契约（SignRequest / SignResponse）

与 [libresoda](https://github.com/sodahub-org/libresoda) 的 `soda::signature` 模块、以及
Meting-API 的远程签名服务保持兼容，
三者的 JSON 可以直接互换。

## POST /sign

请求：

```jsonc
{
  "url": "https://api.qishui.com/luna/pc/track_v2?aid=386088&…",
  "method": "POST",
  "body": "{\"track_id\":\"7501674235158431760\",\"media_type\":\"track\",\"queue_type\":\"favorite_track_playlist\",\"scene_name\":\"library\"}",
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "user-agent": "LunaPC/3.8.0(467160162)",
    "x-ss-stub": "8DF5FA2E7969A4EEA321B0EFC6F3F9BA",   // body 的 MD5（大写）
    "cookie": "sessionid_ss=…",
    "x-luna-background-type": "foreground",
    "x-luna-is-background-req": "0",
    "x-luna-is-local-user": "0",
    "x-tt-trace-id": "00-…-…-01"
  },
  "ts_ms": 1789435000000
}
```

响应：

```json
{
  "ok": true,
  "headers": { "X-Helios": "…", "X-Medusa": "…" },
  "device_id": "<device_id>",
  "elapsed_ms": 6
}
```

失败：

```json
{ "ok": false, "error": "未找到 bdms.node：请设置 LIBMSSDK_BDMS_MODULE（或未提供 bdms.node / metasecml.dll）", "code": "signer_error" }
```

## GET /healthz 与 GET /config

```jsonc
// /healthz（无需鉴权，设备号脱敏）
{ "ok": true, "service": "libmssdk", "version": "0.1.0", "bdmsAvailable": true,
  "deviceId": "746***847", "auth": true, "platform": "win32" }

// /config（需鉴权）——客户端可用它对齐设备身份
{ "ok": true, "bdmsModule": "…\\vendor\\soda-music\\bdms.node",
  "bundledBdms": "…", "clientDir": "",
  "deviceId": "746***847",
  "identity": { "device_id": "<device_id>", "iid": "<install_id>",
                "fp": "<device_id>", "source": "state" },
  "requestTimeoutMs": 15000 }
```

`identity` 就是服务当前使用的设备指纹（首次运行随机生成并落盘，可用
`LIBMSSDK_DEVICE_ID` / `LIBMSSDK_IID` / `LIBMSSDK_FP` 覆盖）。调用方把它抄到自己的
URL 参数里即可保证「签名器 / URL / 会话」同设备。

### 三条硬性约定

1. **签名覆盖 URL + 全部请求头**。
   官方 `src/app.ts` 把 headers 展平成 `"名字\r\n值\r\n…"` 交给
   `bdms.generateHttpSignatureHeaders`，再把返回的 name/value 成对写回请求。
   因此 `headers` 必须是**真实要发出去的那一份**：少一个（尤其 `cookie`、
   `x-ss-stub`）都会被服务端判成空响应。
2. **`x-ss-stub` = body 的 MD5（大写）**，是签名输入的一部分，也要随请求发出去。
3. **设备必须成套**：`device_id`（以及 URL 里的 `iid` / `fp`）要和
   `bdms.init({ deviceId })` 用的是同一个设备；换设备要重新抓指纹。

## 兼容形态

调用方按 Meting 的扁平写法回包也能解析：

```json
{ "ok": true, "X-Helios": "…", "X-Medusa": "…" }
```

## POST /probe 与 /track/stream

请求：

```jsonc
{
  "track_id": "7501674235158431760",
  "cookie": "sessionid_ss=…",     // 可选；不传就是匿名（VIP 曲目只会得到试听）
  "device_id": "<device_id>", // 可选，默认取服务自身的设备身份（见 /config）
  "iid": "<install_id>",
  "fp": "<device_id>"
}
```

响应（`/probe`）：

```jsonc
{
  "ok": true,
  "http": 200,
  "accepted": true,          // 签名被服务端接受（不是空 body）
  "bodyBytes": 26529,
  "trackId": "7501674235158431760",
  "name": "下完这场雨",
  "trackDurationSeconds": 236.62,
  "streamDurationSeconds": 236.62,
  "fullTrack": true,         // ← 整曲判定
  "gears": [
    { "gear": "0:M4A|1:audio_encrypt|2:aac|5:highest", "quality": "highest", "codec": "aac", "bitrate": 260286, "size": 4408084 },
    { "gear": "0:MP4|1:audio_encrypt|2:flac|5:lossless", "quality": "lossless", "codec": "flac", "bitrate": 1741286, "size": 46275289 }
  ],
  "bestGear": { "quality": "lossless", "bitrate": 1741286, "size": 46275289 },
  "hint": "整曲（6 档，最高 lossless 1741kbps）"
}
```

`fullTrack` 的判定：`stream_duration + 2s >= track.duration`。

## stdio 模式

```bash
echo '{"url":"https://api.qishui.com/luna/pc/track_v2?device_id=…","method":"POST","body":"{}","headers":{}}' \
  | node src/index.mjs bridge
```

输出与 `/sign` 的响应体一致（一行 JSON），可直接作为 libresoda
`CommandSignature` 的后端。
