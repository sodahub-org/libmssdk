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
- 上表描述的是 `/sign`；`/readyz` 的 503 是就绪探针结果，不带 `Retry-After` 或原因码。
- `/sign` 按精确 pathname 匹配：`/sign/` 是 404。探针与已删端点的回执认尾斜杠（`/readyz/`、
  `/probe/` 都算同一条），因为「看不懂发生了什么」正是那两条要防的事，而 `/sign` 少一个字节
  的签名覆盖都成立不了，多一个斜杠就该被当成另一条路由。
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
- 限流只覆盖 `/sign` —— #9 之后它是 HTTP 上唯一的计算入口，也是唯一会被打上游的路径。
  `/livez`、`/readyz`（与别名）、`/stat` 与已删端点的回执都不参与限流计数，也不打访问日志：
  拦它们既不省容量也不防滥用，只会让探针在过载时改口，把「服务还活着」读成「服务死了」。
- **绑定非回环地址且没有设置 `LIBMSSDK_TOKEN` 时拒绝启动**，并给出原因；绑定回环地址时
  不配令牌才放行（本机自用）。直接构造 `createDispatcher` 的嵌入用法也走同一道检查。

## GET /stat

诊断端点：不鉴权、不参与限流计数、不打访问日志。没有监控系统时，用它判断出了什么事。
`/sign` 之外它读的是同一份装配状态（队列、worker、限流器），所以数字与真实行为一致。

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
    "trustProxy": false,
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
`rateLimit.trustProxy` 是 #8 那个开关的运行时视图：#9 删掉了明文返回整套设备身份的 `/config`，
而「重启前能不能核对部署开关」这条得留着，就挪到这里。计数会暴露使用情况（桶数、允许/拒绝），
公网部署时别让它经公网可达，见 `deploy/README.md`。

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

### 收尾在哪些形态生效

「开始收尾 → `/readyz` 当场改口」依赖进程能收到信号。按部署形态分开说：

| 形态 | 收尾触发 | 停止期间看到的 |
| --- | --- | --- |
| 前台 `Ctrl+C`、Linux/macOS 的 `SIGTERM` | 进程直接收到 `SIGINT` / `SIGTERM` | 先 503，再连接被拒 |
| Docker（`docker stop` / compose） | `deploy/entrypoint.sh` 把 `SIGTERM` 转成 `SIGINT` 交给 Wine | 先 503，再连接被拒 |
| nssm 停止 | 默认先发 Ctrl+C，Node 收到 `SIGINT`；升级到终止进程时同下一行 | 先 503，再连接被拒 |
| `schtasks /end`、`taskkill /F`、超过宽限的 `SIGKILL` | 拿不到信号（`TerminateProcess`） | 从连接被拒/重置开始 |

表中「先 503」要排空窗口大于 0 才观察得到：默认 `LIBMSSDK_DRAIN_DELAY_MS=0` 时改口与停监听几乎
同时发生，探针仍可能只看到连接被拒。容器 compose 与 `verify/wine-multi` 都已显式给窗口。

- Wine 只把 `SIGINT` 映射成 Windows 的 `CTRL_C_EVENT`，不映射 `SIGTERM`；容器里的转发就是补这一跳。
- **排空窗口**：`markClosing()` 之后先保持监听，让探针真的读到 503，再停监听、收在飞与排队请求。
  由 `LIBMSSDK_DRAIN_DELAY_MS` 控制，默认 `0`（信号一到就停监听，与旧行为一致）；容器 compose
  显式设为 8 秒，并配 `stop_grace_period: 30s`。窗口只推迟「停监听」，不推迟「改口」。
- 窗口与宽限期要覆盖编排器的摘流延迟；两者之和必须小于 `stop_grace_period`，否则进程会被硬杀。
- **不生效的形态要把承诺说小**：`schtasks /end` 走 `TerminateProcess`，无法拦截；要优雅停止就换成
  nssm 或真正的 Windows 服务，而不是等计划任务发信号。

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
