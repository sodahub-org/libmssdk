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
| 单 IP 超限（限流启用后） | 429 | `RATE_LIMITED` | 有 |
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
- 上表描述的是 `/sign`；`/readyz` 的 503 是就绪探针结果，不带 `Retry-After` 或原因码。
- `/sign` 按精确 pathname 匹配：`/sign/` 是 404。探针与已删端点的回执认尾斜杠（`/readyz/`、
  `/probe/` 都算同一条），因为「看不懂发生了什么」正是那两条要防的事，而 `/sign` 少一个字节
  的签名覆盖都成立不了，多一个斜杠就该被当成另一条路由。

## GET /livez 与 GET /readyz

```jsonc
// /livez —— 恒 200，不查任何依赖、不做任何计算：只回答「进程还在不在」
{ "ok": true, "service": "libmssdk", "version": "0.1.0" }

// /readyz —— 至少一台 worker 就绪、且不在收尾过程中才 200，否则 503（无需鉴权，设备号脱敏）
{ "ok": true, "ready": true, "service": "libmssdk", "version": "0.1.0",
  "deviceId": "746***847", "auth": true, "platform": "win32" }
```

`GET /healthz` 是 `/readyz` 的别名，回的是同一份内容，留给已经配好探针的部署。

两个端点分开的原因：探针问「你还活着吗」和「你能干活吗」是两件事。合成一个时，预热期里的探活
要么误报「活着」（其实还没法服务），要么误报「死了」（把还在起的服务判死）。**队列饱满程度不进
`/readyz`**：过载时把自己从上游摘掉，剩下的实例只会更忙，是标准的死亡螺旋；过载的信号走普通
请求路径的 503。

### 设备身份怎么对齐

原先这一份由 `GET /config` 提供，那个端点会明文返回完整设备号与安装号，而没有任何客户端在调它，
已经删掉了。今天有三条路，按你能碰到什么选：

| 要什么 | 从哪里拿 |
| --- | --- |
| 服务当前用的 `device_id` | `POST /sign` 时**不点名**设备号（URL、headers、请求体里都不给 `device_id` / `fp` / `did`），回包里的 `device_id` 就是签名器自己那份 |
| 整套 `device_id` / `iid` / `fp` | 同一台机器上读 `data/identity.json`（即 `LIBMSSDK_STATE_DIR` 里那份），或本机跑 `node src/index.mjs config` 看来源与脱敏值 |
| 钉死成调用方也认识的一份 | 服务端设 `LIBMSSDK_DEVICE_ID` / `LIBMSSDK_IID` / `LIBMSSDK_FP`，双方按同一份约定 |

服务当前使用的设备指纹由首次运行的独占创建生成并落盘（state 目录可用时多个进程同时首次启动也只会
生成一份，慢 IO 下另有残留窗口见 `DEPLOY-WINDOWS.md`；内容损坏时才重建，可用
`LIBMSSDK_DEVICE_ID` / `LIBMSSDK_IID` / `LIBMSSDK_FP` 覆盖）。调用方把它抄到自己的 URL 参数里，
即可保证「签名器 / URL」用同一份设备号；抄哪一份见上一小节那张表。

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

## 自检：命令行 `probe`（HTTP 端点已收掉）

`/probe` 与 `/track/stream` 会拿调用方给的 Cookie 去请求上游，再把几十 KB 到几 MB 的响应透传回来。
那个令牌写在公开的客户端源码里，等于没有鉴权；上游看到的是「同一个 IP、大量不同设备号、高频请求」
——最典型的爬虫特征，被封的是这台服务器，而 `/sign` 的所有正常用户一起失败。症状出现在签名上，
根因在这两个诊断端点。所以自检能力从 HTTP 挪回终端：只在人手动执行时存在。

```bash
node src/index.mjs probe --track 7501674235158431760 --cookie "sessionid_ss=…"
# --device / --iid / --fp 可指定身份；不指定就用服务自己那份（data/identity.json）
# Cookie 是可选的：实测在会给出整曲的曲目上，不发 Cookie 也照样整曲（签名才是取流凭据；
# 没测过的组合见调查报告第七节）
```

输出与收掉之前的 `/probe` 回包同形（只多一个脱敏的 `deviceId`），`fullTrack` 为 `false` 时退出码 1，
方便脚本判断：

```jsonc
{
  "http": 200,
  "deviceId": "746***847",   // 只出脱敏值
  "ok": true,
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

`fullTrack` 的判定：`stream_duration + 2s >= track.duration`。空 body（`HTTP 200 + 0 字节`）代表
签名没被接受，不代表接口故障。

### 旧端点现在回什么

弃用节奏给自托管用户留一个版本的缓冲，不静默 404：

| 版本 | `/probe`、`/track/stream` 的回包 |
| --- | --- |
| 本版本 | **404** + `Deprecation: @1793404800`（RFC 9745 要求值是 Structured Field 的 Date，所以头里写成 `@<秒>`；它等于 `Sat, 31 Oct 2026 00:00:00 GMT`，本版本发布之日）+ `Sunset: Fri, 30 Apr 2027 23:59:59 GMT`（RFC 8594）；回包里 `code: "endpoint_removed"`、`replacement` 写明替代命令，两个时刻也各写一份（`deprecated_at` / `sunset` 用能直接读的 HTTP-date，不把头里的 `@<秒>` 编码抄进 JSON） |
| 下一版本 | **410**，其余不变 |

`Sunset` 不早于 `Deprecation`，两个日期是一对：如果「下一版本」实际晚于 `Sunset`，发版时要
`src/endpoints.mjs` 里这一对常量一起往后推 —— 头里写着「早已到期」比不发这个头更糟。

回执对没带凭据的调用方也回（与通用 404 同一条路径）：回包全是常量，没有任何服务侧数据，
也不签名、不出网。鉴权守的是能力，能力已经不在这条路上了。

两条路由都认得，但都不再签名、也不再打上游 —— 它们只回答「这里没有了，改用这个」。

`/track/stream` 的替代不在命令行里：它产出的「整曲还是试听」，客户端本来就拿得到响应，判断逻辑应该
在客户端 —— 用 `/sign` 取到签名头后自己请求上游，比较 `video_duration` 与 `track.duration`。

`GET /config` 没有这一对头，因为它不是「将要移除」而是「本次就没了」：它把完整设备号与安装号明文交出去，
而没有任何客户端在调用它。它同样回 404 + `code: "endpoint_removed"` 与替代做法，不是静默的 not_found。

## stdio 模式

```bash
echo '{"url":"https://api.qishui.com/luna/pc/track_v2?device_id=…","method":"POST","body":"{}","headers":{}}' \
  | node src/index.mjs bridge
```

输出与 `/sign` 的响应体一致（一行 JSON），可直接作为 libresoda
`CommandSignature` 的后端。
