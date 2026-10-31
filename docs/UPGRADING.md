# 升级说明：默认多进程、新的错误契约，以及诊断端点收拢

本版本有两批变化：`serve` 的默认路径切到「主进程监听 + worker 计算」并启用新的状态码契约（#7），
签名之外的 HTTP 面收拢成一个处理器、健康检查拆成语义分明的两个（#9）。

对外的变化是：`/sign` 的计算方式与失败状态码；`/livez` 与 `/readyz` 两个健康端点；
`/probe`、`/track/stream`、`/config` 从 HTTP 上拿掉；交付能直接用的反向代理配置。
`bridge` / `selftest` / `probe` 这几个本地命令不变。

## 1. 默认启动多个进程

`node src/index.mjs serve` 现在由主进程独占端口、解析 HTTP、排队；每个 worker 进程只负责
调用 `bdms.node` 算一次签名。

worker 数按绑定地址推导，环境变量始终优先：

| 场景 | worker 数 |
| --- | --- |
| `LIBMSSDK_BIND` 是回环地址（默认 `127.0.0.1`） | 1 |
| 绑定非回环地址 | `availableParallelism() / 2`（估算物理核）的 75% |
| 设置了 `LIBMSSDK_WORKERS` | 按设置值 |

启动日志的 `event=dispatcher` 会写明实际值与来由；`event=serve` 会写 `workers` 和实际监听地址。
进程数变化不需要改客户端。

可调的等待与队列参数见 [`.env.example`](../.env.example)：`LIBMSSDK_WAIT_BUDGET_MS`（默认 5000）、
`LIBMSSDK_QUEUE_LIMIT`（默认 worker 数的 4 倍）、`LIBMSSDK_WARMUP_BUDGET_MS`（默认 30000）。

## 2. `/sign` 会排队，服务忙时回 503

并发超过空闲 worker 时，请求会排队而不是立刻失败。**队列已满时立即回 503**；已经入队的请求
超过等待预算（默认 5 秒）也回 503。两种情况都返回 **503 `BUSY`**，并在响应头和响应体各写一份
`Retry-After: 1`。客户端应按这个时长退避重试，而不是把 503 当成永久失败。

签名接口没有副作用，可以安全重试。

## 3. 失败状态码

| 情况 | 状态码 | 原因码 | `Retry-After` |
| --- | --- | --- | --- |
| 成功 | 200 | — | 无 |
| 请求格式非法（非法 JSON、缺 `url`、请求体超限） | 400 | `INVALID_REQUEST` | 无 |
| 鉴权失败 | 401 | `UNAUTHORIZED` | 无 |
| 单 IP 超限（限流启用后） | 429 | `RATE_LIMITED` | 有 |
| 没有就绪 worker / 队列已满（立即），或已入队请求超过等待预算 | 503 | `BUSY` | 有（固定 1 秒） |
| 模块没加载 / 配置错 | 500 | `SIGNER_UNAVAILABLE` | 无 |
| 签名算错 / worker 中途退出 | 500 | `INTERNAL_ERROR` | 无 |

**502 不再出现在任何出口。** 本服务不是网关，把本地配置错误或 worker 故障报成 502 会让监控
找错方向。调用方如果按 502 做重试或告警，需要改成按上表处理。

限流（429）由后续的按 IP 限流版本启用；本版本的错误写出路径已经支持它，但默认还没有限流器。

## 4. 健康检查拆成两个

| 端点 | 什么时候 200 | 用来干什么 |
| --- | --- | --- |
| `GET /livez` | 恒 200，不查任何依赖、不做任何计算 | 「进程还在不在」 |
| `GET /readyz` | 至少一台 worker 就绪，**且**不在收尾过程中 | 「能不能干活」 |

`GET /healthz` 保留为 `/readyz` 的别名，回的是同一份内容：已有的编排配置不改也还能用。

未就绪时 `/readyz` 回 503 + `ready: false`，不带 `Retry-After` 也不带原因码（探针的回包不是
`/sign` 的错误契约）。这条改动是为了避开一个实测踩过的坑：Docker 的起始宽限期只在「从未成功过」
时保护，预热期间只要有一次 200，宽限当场作废，后面的 503 就不再保护你了 —— 所以
`/readyz` 在没有就绪 worker 时绝不谎报 200。

**队列饱满不进就绪判定。** 过载时把自己从上游摘掉，剩下的实例只会更忙，这是标准的死亡螺旋。
过载的信号走普通请求路径的 503 `BUSY`。

## 5. 诊断端点收拢（#9）

三个端点从 HTTP 上拿掉了。原因不是一个字节的浪费，而是「任何人都能借这台机器去打上游」：
`/probe` 与 `/track/stream` 接受调用方给的 Cookie 去请求官方接口，再把几十 KB 到几 MB 的响应透传
回来，而那个令牌写死在公开的客户端源码里 —— 等于没有鉴权。被封的是这台服务器，跟着一起失败的
是这台服务器上所有正常签名请求的用户。

| 端点 | 现在 | 替代 |
| --- | --- | --- |
| `POST /probe` | 只回 404 + `Deprecation` + `Sunset` 的回执，指向命令行 | `node src/index.mjs probe --track <track_id>`（输出字段与之前一致，多一个脱敏 `deviceId`） |
| `POST /track/stream` | 同上 | 客户端自己判断：用 `/sign` 取到签名头后请求上游，比较 `video_duration` 与 `track.duration` |
| `GET /config` | 直接删（没有弃用期） | 服务自己的 `device_id`：`/sign` 时不点名设备号，回包里就是它；整套身份看 `data/identity.json` 或 `node src/index.mjs config` |

弃用节奏：**本版本**给「弃用 + 到期」信号并写明替代命令，**下一版本**才让这两条路由返回 410。
两个版本都不许退成静默 404 —— 自托管的人各自控制升级节奏，回包看不懂就等于没有过渡。

签名之外的 HTTP 面从此只有一个处理器（`src/endpoints.mjs`）。出网的代码也只剩一处
（`src/probe.mjs` 的 `fetchTrackV2`），入口只有命令行 `probe` 与手动脚本：HTTP 层不留任何
「拿调用方输入打上游」的路径，`test/endpoints.test.mjs` 里有一条结构守卫盯着这件事，防止日后
又有人给 HTTP 加一条诊断路由。

顺带一条：`src/server.mjs` 里那份进程内 `/sign` 老路径也退场了。签名只有分发器一条路
（主进程排队、worker 计算），主进程那份 signer 不再进 HTTP 层，只给 `selftest` / `probe` /
`bridge` 这三个本地命令用。

## 6. TLS：配置交付了，进程内仍然不做

- 仓库里有能直接用的反向代理配置，不用再自己拼：
  [`deploy/reverse-proxy/Caddyfile`](../deploy/reverse-proxy/Caddyfile)（Windows 裸机与 Docker
  通用；域名可解析时自动签发并续期证书）、
  [`deploy/reverse-proxy/nginx.conf`](../deploy/reverse-proxy/nginx.conf)（已有 nginx 的主机）、
  [`deploy/docker-compose.proxy.yml`](../deploy/docker-compose.proxy.yml)（容器形态叠一层）。
- **进程内不做 TLS**，原因不是省事：证书续期意味着重启那个正握着 `bdms.node` 的进程，而冷启动
  恰恰是最危险的一步（预热没完成时每个 `/sign` 都是 503）；进程内做 TLS 也没有任何办法照顾已经
  发布出去的老客户端。
- **明文通道上 token 会泄露**，而这个 token 等价于签名能力。**上了 TLS 必须换一个新 token**：
  旧 token 已经在无数人的历史流量里出现过，换协议不等于换凭据。
- **明文端口继续完整服务，不配 80 → 443 重定向**：308 对不跟随重定向的客户端是直接失败，对已经
  拿到明文的请求又毫无增益 —— 它只是个提示，不是迁移机制。同理不开 HSTS（一旦下发，还在走明文的
  客户端会被锁死），也不做证书固定。

## 7. 升级检查清单

1. 确认反向代理/客户端把非 2xx 当成「可重试与否」的信号，而不是一律当上游故障。
2. 如果之前把 502 配成告警，改成 500 `SIGNER_UNAVAILABLE` / `INTERNAL_ERROR`。
3. 多进程部署时给每个 `serve` 进程留出内存：每个 worker 都要加载一份原生模块。
4. Docker 健康检查已改指 `/readyz`（间隔 10 秒，起始宽限期仍 180 秒）；自己维护探针的话，
   「进程在不在」用 `/livez`，「能不能干活」用 `/readyz`。
5. 全文搜一遍脚本与文档里的 `/probe`、`/track/stream`、`/config`：前两个在弃用期回带信号的
   404（下一版本 410），第三个直接 404。改成命令行 `probe` / 客户端自己判断 / 读身份文件。
6. 决定上 TLS 的，配置抄 `deploy/reverse-proxy/`，然后**换一个新的 `LIBMSSDK_TOKEN`**。
