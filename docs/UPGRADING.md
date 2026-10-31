# 升级说明：默认多进程与新的错误契约

本版本把 `serve` 的默认路径切到「主进程监听 + worker 计算」（#7）。对外的变化是
`/sign` 的计算方式与失败状态码，以及 `/healthz` 的就绪语义；`bridge` / `selftest` /
`probe` 这几个本地命令不变。

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

## 3. 默认按 IP 限流，新增 /stat 诊断端点

`/sign`（以及过渡期的 `/probe`、`/track/stream`）现在默认按客户端地址限流：

- 分桶键是 TCP 对端地址：IPv4 按单地址、IPv6 按 /64 聚合。令牌写在公开客户端源码里，
  不是凭据，不参与分桶。
- 默认持续 0.5 次/秒、突发 12，阈值故意宽松——共享出口后面几十个人共用一个地址。
  桶总数封顶（默认 4096），满了挤掉最久没动的桶；过期桶会被回收。
- 超限返回 **429 `RATE_LIMITED`**，`Retry-After` 是「下次可请求的精确时刻向上取整、最少 1 秒」。
  它和 503 `BUSY` 的区别是：429 是你打得太快，503 是服务容量不够。
- 只有显式设置 `LIBMSSDK_TRUST_PROXY=1` 才读 `X-Forwarded-For`，取最右边一跳。默认只认
  TCP 对端地址；挂在反向代理后面又不打开它，所有请求会挤进代理那一个桶。
- 默认强制生效。运行时可把 state 目录下的 `rate-limit.mode` 写成 `enforce` / `log` / `off`，
  约 2 秒内生效：`log` 只记日志不拦（调参期），`off` 完全不参与。`data/rate-limit.mode`
  与 `identity.json` 同目录；文件不存在时使用 `LIBMSSDK_RATE_LIMIT_MODE`（默认 `enforce`）。

新增 **`GET /stat`**：返回活跃桶数、允许/拒绝计数、队列深度、当前 worker 数，以及拒绝次数最多的
几个桶。地址全部脱敏；该端点不鉴权、不参与限流计数、不打访问日志，预热期间也能回答。

参数见 [`.env.example`](../.env.example)：`LIBMSSDK_RATE_LIMIT_PER_SECOND`、
`LIBMSSDK_RATE_LIMIT_BURST`、`LIBMSSDK_RATE_LIMIT_MAX_BUCKETS`、
`LIBMSSDK_RATE_LIMIT_MODE`、`LIBMSSDK_RATE_LIMIT_MODE_FILE`、
`LIBMSSDK_RATE_LIMIT_MODE_POLL_MS`、`LIBMSSDK_TRUST_PROXY`。

## 4. 失败状态码

| 情况 | 状态码 | 原因码 | `Retry-After` |
| --- | --- | --- | --- |
| 成功 | 200 | — | 无 |
| 请求格式非法（非法 JSON、缺 `url`、请求体超限） | 400 | `INVALID_REQUEST` | 无 |
| 鉴权失败 | 401 | `UNAUTHORIZED` | 无 |
| 单 IP 超限（默认启用，可用控制文件降级） | 429 | `RATE_LIMITED` | 有 |
| 没有就绪 worker / 队列已满（立即），或已入队请求超过等待预算 | 503 | `BUSY` | 有（固定 1 秒） |
| 模块没加载 / 配置错 | 500 | `SIGNER_UNAVAILABLE` | 无 |
| 签名算错 / worker 中途退出 | 500 | `INTERNAL_ERROR` | 无 |

**502 不再出现在任何出口。** 本服务不是网关，把本地配置错误或 worker 故障报成 502 会让监控
找错方向。调用方如果按 502 做重试或告警，需要改成按上表处理。

限流（429）默认生效，行为见上一节；调参期可以切成 `log` 或 `off`。

## 5. 鉴权：非回环绑定必须有令牌

以前「没配令牌就等于全开放」。现在：

- 绑定回环地址（`127.0.0.1`、`::1`、`localhost`）且没配令牌：照常放行，本机自用。
- 绑定非回环地址（`0.0.0.0`、`::`、局域网 IP 等）且没配令牌：**拒绝启动**，并在日志里写明原因。
  不会再静默对所有人开放。
- `LIBMSSDK_ALLOW_ANONYMOUS` 不再有作用，已从配置里移除。

## 6. 健康检查与过渡端点

`GET /healthz` 仍然可用，但现在只有在**至少一台 worker 就绪**时才返回 200；预热期间返回 503。
这避免编排器在预热中途把流量放进来——起始宽限期一旦看到过 200 就会作废。
响应体多了一个 `ready` 字段。健康探针的 503 不参与 `/sign` 的错误分类，因此不带
`Retry-After` 或原因码。

以下端点在过渡期继续可用，等端点收拢版本（#9）再按弃用节奏处理：

- `GET /config`
- `POST /probe`（上游非 200 时现在回 500 `INTERNAL_ERROR`，不再回 502）
- `POST /track/stream`

这三个端点的鉴权失败现在与 `/sign` 一样使用 401 `UNAUTHORIZED`。注意 `/probe` 与
`/track/stream` 过渡期仍在主进程里同步签名，调用它们会短暂占住主进程事件循环；收拢版本
会把 `/probe` 改成命令行子命令并删除 `/track/stream` 的 HTTP 入口。`/probe` 与
`/track/stream` 从本版本起与 `/sign` 共用同一个按 IP 限流器。

## 7. 升级检查清单

1. 确认反向代理/客户端把非 2xx 当成「可重试与否」的信号，而不是一律当上游故障。
2. 如果之前把 502 配成告警，改成 500 `SIGNER_UNAVAILABLE` / `INTERNAL_ERROR`。
3. 多进程部署时给每个 `serve` 进程留出内存：每个 worker 都要加载一份原生模块。
4. Docker 健康检查仍指向 `/healthz`；无需改配置。
5. 挂反向代理的部署：要么设置 `LIBMSSDK_TRUST_PROXY=1`（并确认代理会重写
   `X-Forwarded-For`），要么接受所有客户端共用一个桶。
6. 绑定非回环地址的部署必须设置 `LIBMSSDK_TOKEN`，否则服务会拒绝启动。
7. 出问题时先看 `GET /stat`；调参期可把 state 目录下的 `rate-limit.mode` 写成 `log`。
