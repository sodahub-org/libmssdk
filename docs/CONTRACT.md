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

失败按「调用方下一步做什么」分类，原因码是稳定字符串（下表描述默认 `serve` 路径的 `/sign`）：

| 情况 | 状态码 | `code` | `Retry-After` |
| --- | --- | --- | --- |
| 请求格式非法（非法 JSON、缺 `url`、请求体超限） | 400 | `INVALID_REQUEST` | 无 |
| 鉴权失败 | 401 | `UNAUTHORIZED` | 无 |
| 单 IP 超限（默认启用，可用控制文件降级） | 429 | `RATE_LIMITED` | 有 |
| 没有就绪 worker / 队列已满（立即），或已入队请求超过等待预算 | 503 | `BUSY` | 有（固定 1 秒） |
| 模块没加载 / 配置错 | 500 | `SIGNER_UNAVAILABLE` | 无 |
| 签名算错 / worker 中途退出 | 500 | `INTERNAL_ERROR` | 无 |

```json
{ "ok": false, "error": "缺少或错误的 Bearer Token", "code": "UNAUTHORIZED" }
{ "ok": false, "error": "服务忙：没有空闲的签名槽位", "code": "BUSY", "retry_after_seconds": 1 }
```

- 只有 `BUSY` 与 `RATE_LIMITED` 带等待时长；整数秒，响应头与响应体各一份。
- `details` 这类动态信息是平级扩展字段，客户端可以忽略不认识的键。
- **502 不再出现**：本进程不是网关，本地配置错误与 worker 故障都按上表收口。
- 签名接口没有副作用，可以安全重试。没有就绪 worker 或队列已满时**立即**回 503；
  只有已经入队的请求才会在等待预算（默认 5 秒）用尽后回 503。
- 上表描述的是 `/sign`；`/healthz` 的 503 是就绪探针结果，不带 `Retry-After` 或原因码。
- 429 的等待时长是「下次可请求的精确时刻向上取整」，最少 1 秒；503 固定 1 秒。两者都能重试，
  但 429 说明是调用方自己打得太快，503 说明是服务容量不够。

## 准入控制

- 分桶键是 TCP 对端地址：IPv4 一个地址一个桶，IPv6 按 /64 聚合。鉴权令牌写在公开的客户端
  源码里，不是凭据，不参与分桶。
- 默认持续 0.5 次/秒、突发 12。阈值故意宽松：共享出口后面几十个人共用一个地址，紧阈值会
  把整栋楼的人挡在门外。桶总数有上限，满了挤掉最久没动的桶；过期桶会被回收。地址轮换者
  仍可能拿到新的突发额度，但服务总容量仍由队列与 503 兜底。
- 只有在显式设置 `LIBMSSDK_TRUST_PROXY=1` 时才读 `X-Forwarded-For`，并取最右边一跳 ——
  直接对端反向代理亲眼看到的地址。默认只认 TCP 对端地址。打开它时，服务端口必须只对
  反向代理开放（通常把宿主机端口绑到 127.0.0.1），否则调用方可以绕过反代直连并伪造 XFF，
  自选分桶键、绕过限流。
- 默认强制生效。运行时可把 state 目录下的 `rate-limit.mode` 写成 `enforce` / `log` / `off`
  （约 2 秒内生效，不用重启）：`log` 只记日志不拦，`off` 完全不参与。
- POST 计算端点（`/sign`、`/probe`、`/track/stream`）共用同一个限流器；`/stat`、`/healthz`、
  `/config` 不参与限流计数，也不打访问日志。
- **绑定非回环地址且没有设置 `LIBMSSDK_TOKEN` 时拒绝启动**，并给出原因；绑定回环地址时
  不配令牌才放行（本机自用）。直接构造 `createDispatcher` / `createLegacyHandler` 的嵌入
  用法也走同一道检查。

## GET /stat

诊断端点：不鉴权、不参与限流计数、不打访问日志。没有监控系统时，用它判断出了什么事。

```json
{
  "ok": true,
  "service": "libmssdk",
  "version": "0.1.0",
  "queue": { "depth": 0, "limit": 4 },
  "workers": { "total": 1, "ready": 1, "busy": 0 },
  "rateLimit": {
    "mode": "enforce",
    "ratePerSecond": 0.5,
    "burst": 12,
    "maxBuckets": 4096,
    "activeBuckets": 3,
    "allowed": 128,
    "denied": 12,
    "evicted": 0,
    "top": [{ "address": "203.0.*.*", "allowed": 2, "denied": 15 }]
  }
}
```

`top` 只列有拒绝记录的桶（最多 5 个），按拒绝次数排序；`address` 已脱敏（IPv4 留两段、
IPv6 留两个 hextet），不会出现完整 IP。`/stat` 在预热期间也能回答，此时 `workers.ready` 为 0。

## GET /healthz 与 GET /config

```jsonc
// /healthz（无需鉴权，设备号脱敏）。至少一台 worker 就绪才 200；预热中 503 + ready:false。
{ "ok": true, "ready": true, "service": "libmssdk", "version": "0.1.0",
  "bdmsAvailable": true, "deviceId": "746***847", "auth": true, "platform": "win32" }

// /config（需鉴权）——过渡端点，客户端可用它对齐设备身份；端点收拢版本删除
{ "ok": true, "version": "0.1.0", "trustProxy": false,
  "bdmsModule": "…\\vendor\\soda-music\\bdms.node",
  "bundledBdms": "…", "clientDir": "",
  "deviceId": "746***847",
  "identity": { "device_id": "<device_id>", "iid": "<install_id>",
                "fp": "<device_id>", "source": "state" },
  "requestTimeoutMs": 15000 }
```

`identity` 就是服务当前使用的设备指纹（首次运行用独占创建生成并落盘；state 目录可用时
多个进程同时首次启动也只会生成一份，慢 IO 下另有残留窗口见 `DEPLOY-WINDOWS.md`；内容损坏时才重建，可用
`LIBMSSDK_DEVICE_ID` / `LIBMSSDK_IID` / `LIBMSSDK_FP` 覆盖）。调用方把它抄到自己的
URL 参数里，即可保证「签名器 / URL」用同一份设备号。

### 三条硬性约定

1. **签名覆盖 URL + 全部请求头**。
   官方 `src/app.ts` 把 headers 展平成 `"名字\r\n值\r\n…"` 交给
   `bdms.generateHttpSignatureHeaders`，再把返回的 name/value 成对写回请求。
   因此 `headers` 必须是**真实要发出去的那一份**：少一个（尤其 `cookie`、
   `x-ss-stub`）都会被服务端判成空响应。
2. **`x-ss-stub` = body 的 MD5（大写）**，是签名输入的一部分，也要随请求发出去。
3. **设备号要自洽**：URL 里的 `device_id`（以及 `iid` / `fp`）要和
   `bdms.init({ deviceId })` 用的是同一份——这样签名器不必每个请求重新 `init()`。
   这是**本服务内部的约定，不是上游的强制要求**：对照实验里两种设备号形状、
   乃至不带 Cookie，同一首曲目的整曲读数完全一致（详见
   [`INVESTIGATION-DEVICE-ENTITLEMENT.md`](INVESTIGATION-DEVICE-ENTITLEMENT.md)）。

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
  "cookie": "sessionid_ss=…",     // 可选；实测在会给出整曲的曲目上，不发 Cookie 也照样整曲
                                   // （签名才是取流凭据；没测过的组合见调查报告第七节）
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

上游返回非 200 时，`/probe` 现在回 **500 `INTERNAL_ERROR`**（诊断字段仍平铺在回包里，例如
`http`），不再回 502。`/probe` 与 `/track/stream` 都是过渡端点，会按弃用节奏收拢。

## stdio 模式

```bash
echo '{"url":"https://api.qishui.com/luna/pc/track_v2?device_id=…","method":"POST","body":"{}","headers":{}}' \
  | node src/index.mjs bridge
```

输出与 `/sign` 的响应体一致（一行 JSON），可直接作为 libresoda
`CommandSignature` 的后端。
