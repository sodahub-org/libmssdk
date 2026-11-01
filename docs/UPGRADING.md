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

## 3. 默认按 IP 限流，新增 /stat 诊断端点

`/sign` 现在默认按客户端地址限流（#9 之后它是 HTTP 上唯一的计算入口，也是唯一会打上游的路径）：

- 分桶键是 TCP 对端地址：IPv4 按单地址、IPv6 按 /64 聚合。令牌写在公开客户端源码里，
  不是凭据，不参与分桶。
- 默认持续 0.5 次/秒、突发 12，阈值故意宽松——共享出口后面几十个人共用一个地址。
  桶总数封顶（默认 4096），满了挤掉最久没动的桶；过期桶会被回收。
- 超限返回 **429 `RATE_LIMITED`**，`Retry-After` 是「下次可请求的精确时刻向上取整、最少 1 秒」。
  它和 503 `BUSY` 的区别是：429 是你打得太快，503 是服务容量不够。
- 只有显式设置 `LIBMSSDK_TRUST_PROXY=1` 才读 `X-Forwarded-For`，取最右边一跳。默认只认
  TCP 对端地址；挂在反向代理后面又不打开它，所有请求会挤进代理那一个桶。打开它时，服务
  端口必须只对反代开放（通常把宿主机端口绑到 127.0.0.1），否则直连请求可以伪造 XFF。
- 默认强制生效。运行时可把 state 目录下的 `rate-limit.mode` 写成 `enforce` / `log` / `off`，
  约 2 秒内生效：`log` 只记日志不拦（调参期），`off` 完全不参与。`data/rate-limit.mode`
  与 `identity.json` 同目录；文件不存在时使用 `LIBMSSDK_RATE_LIMIT_MODE`（默认 `enforce`）。

新增 **`GET /stat`**：返回活跃桶数、允许/拒绝计数、队列深度、当前 worker 数、`trustProxy` 开关的
当前值，以及拒绝次数最多的几个桶（#9 删掉了明文返回整套设备身份的 `/config`，开关的运行时视图
就挪到这里）。地址全部脱敏；该端点不鉴权、不参与限流计数、不打访问日志，预热期间也能回答。

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

- 绑定回环地址（`127/8` 如 `127.0.0.1`、`::1`、`localhost`）且没配令牌：照常放行，本机自用。
- 绑定非回环地址（`0.0.0.0`、`::`、局域网 IP 等）且没配令牌：**拒绝启动**，并在日志里写明原因。
  不会再静默对所有人开放。
- `LIBMSSDK_ALLOW_ANONYMOUS` 不再有作用，已从配置里移除。

## 6. 健康检查拆成两个

| 端点 | 什么时候 200 | 用来干什么 |
| --- | --- | --- |
| `GET /livez` | 恒 200，不查任何依赖、不做任何计算 | 「进程还在不在」 |
| `GET /readyz` | 至少一台 worker 就绪，**且**不在收尾过程中 | 「能不能干活」 |

`GET /healthz` 保留为 `/readyz` 的别名，回的是同一份内容：已有的编排配置不改也还能用。

未就绪时 `/readyz` 回 503 + `ready: false`，不带 `Retry-After` 也不带原因码（探针的回包不是
`/sign` 的错误契约）。这条改动是为了避开一个实测踩过的坑：Docker 的起始宽限期只在「从未成功过」
时保护，预热期间只要有一次 200，宽限当场作废，后面的 503 就不再保护你了 —— 所以
`/readyz` 在没有就绪 worker 时绝不谎报 200。

回包字段相对旧的 `/healthz` 少了一个 `bdmsAvailable`：它量的是「主进程看得到模块文件吗」，而默认路径
上签名发生在 worker 里，那个字段会让人以为它说的是「能不能签名」。就绪与否只看 `ready`；worker 数、
队列深度与限流计数都在 `GET /stat` 里，不挤进就绪判定 —— `/stat` 只报服务自身的状态，被禁的是
「替调用方打上游」那类端点（见第 7 节）。

**队列饱满不进就绪判定。** 过载时把自己从上游摘掉，剩下的实例只会更忙，这是标准的死亡螺旋。
过载的信号走普通请求路径的 503 `BUSY`。

**「不在收尾过程中」这一条要求信号真的送到进程。** `SIGTERM` / `SIGINT` 到达的第一件事就是让
`/readyz` 改口（`src/index.mjs` 的 shutdown），之后停监听、等在飞与排队的请求收完、最后收 worker。
按部署形态分开说：

| 形态 | 停止时发生什么 | 探针看到的 |
| --- | --- | --- |
| 前台 Ctrl+C、Linux/macOS 的 `SIGTERM`、nssm 停止 | 进程收到 `SIGINT` / `SIGTERM`，走完整收尾 | 先 503（需窗口 > 0），再连接被拒 |
| `docker stop` / compose | `deploy/entrypoint.sh` 把 `SIGTERM` 转成 `SIGINT` 交给 Wine，Node 走完整收尾 | 先 503（需窗口 > 0），再连接被拒 |
| `schtasks /end`、`taskkill /F`、超过 `stop_grace_period` 的 `SIGKILL` | 拿不到信号，`TerminateProcess` 硬杀 | 从连接被拒/重置开始 |

表中「先 503」要排空窗口大于 0 才观察得到；默认 0 时改口与停监听几乎同时，探针仍可能只看到连接被拒。

Wine 只把 `SIGINT` 映射成 Windows 的 `CTRL_C_EVENT`，不映射 `SIGTERM` —— 这就是容器入口必须转一手
的原因。tini / dumb-init 解决的是 PID 1 转发与僵尸回收，不改变 Wine 内部这一跳。

**收尾前留一个排空窗口。** 改口与停监听如果发生在同一刻，探针根本读不到那个 503。
`LIBMSSDK_DRAIN_DELAY_MS`（默认 0，即旧行为）让 `markClosing()` 之后先保持监听；容器 compose 已设
8 秒并配 `stop_grace_period: 30s`。排空窗口 + 在飞请求的收尾时间要小于编排器的停止宽限期，否则进程
会被硬杀。容器形态的「先 503」还要在你实际使用的 Wine 版本上用 `verify/wine-multi` 复验一次
（Wine 9.x 曾有 Ctrl+C 转发的回归）。

**计划任务那一半仍然不优雅。** `schtasks /end` 先发 `WM_CLOSE`（控制台程序收不到），再按
`AllowHardTerminate` 用 `TerminateProcess`；官方文档明确它立即终止、不执行任何终止处理块。要优雅停止
就换 nssm（默认发 Ctrl+C）或真正的 Windows 服务；坚持用计划任务的话，`/end` 之后补一条 `taskkill /T`
清孤儿进程。

## 7. 诊断端点收拢（#9）

三个端点从 HTTP 上拿掉了。原因不是一个字节的浪费，而是「任何人都能借这台机器去打上游」：
`/probe` 与 `/track/stream` 接受调用方给的 Cookie 去请求官方接口，再把几十 KB 到几 MB 的响应透传
回来，而那个令牌写死在公开的客户端源码里 —— 等于没有鉴权。被封的是这台服务器，跟着一起失败的
是这台服务器上所有正常签名请求的用户。

| 端点 | 现在 | 替代 |
| --- | --- | --- |
| `POST /probe` | 只回 404 + `Deprecation`（RFC 9745 的 `@<秒>`）+ `Sunset` 的回执，`code: "endpoint_removed"`，指向命令行 | `node src/index.mjs probe --track <track_id>`（输出字段与之前一致，多一个脱敏 `deviceId`） |
| `POST /track/stream` | 同上 | 客户端自己判断：用 `/sign` 取到签名头后请求上游，比较 `video_duration` 与 `track.duration` |
| `GET /config` | 删（没有弃用期，所以不带到期头），但同样回一句「没有了 + 替代做法」，不是静默 404 | 服务自己的 `device_id`：`/sign` 时不点名设备号，回包里就是它；整套身份看 `data/identity.json` 或 `node src/index.mjs config`；#8 的 `trustProxy` 开关改由启动日志与 `GET /stat` 核对 |

弃用节奏：**本版本**给「弃用 + 到期」信号并写明替代命令，**下一版本**才让这两条路由返回 410。
两个版本都不许退成静默 404 —— 自托管的人各自控制升级节奏，回包看不懂就等于没有过渡。

回执与健康探针都不看凭据也不看方法：回包要么全是常量，要么是运行状态（地址与设备号都脱敏），
不签名、不出网。鉴权守的是能力，而能力已经不在这几条路上了（AGENTS.md 第 9 条）。限流也因此
只覆盖 `/sign` —— 它是 HTTP 上唯一的计算入口，也是唯一会打上游的路径。

签名之外的 HTTP 面从此只有一个处理器（`src/endpoints.mjs`）。出网的代码也只剩一处
（`src/probe.mjs` 的 `fetchTrackV2`），入口只有命令行 `probe` 与手动脚本：HTTP 层不留任何
「拿调用方输入打上游」的路径，`test/endpoints.test.mjs` 里有一条结构守卫盯着这件事，防止日后
又有人往 HTTP 上加一条「替调用方做事」的诊断路由。只报服务自身状态的 `GET /stat` 不属于那一类，
它是 #1 点名要的，也确实在那里。

顺带一条：`src/server.mjs` 里那份进程内 `/sign` 老路径也退场了。签名只有分发器一条路
（主进程排队、worker 计算），主进程那份 signer 不再进 HTTP 层，只给 `selftest` / `probe` /
`bridge` 这三个本地命令用。

## 8. TLS：配置交付了，进程内仍然不做

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
- **「不重定向」指的是签名服务自己的明文端口**：它继续完整服务，不改成跳转 —— 308 对不跟随重定向
  的客户端是直接失败，对已经拿到明文的请求又毫无增益。**代理自己的 80 不在这句话里**：Caddy 的自动
  HTTPS 默认就在 80 上放一个到 443 的跳转（要关掉就加 `auto_https disable_redirects`），nginx 那份
  只有 443 的 server block。同理本服务不开 HSTS（一旦下发，还在走明文的客户端会被锁死），
  也不做证书固定。
- **上了反代要收紧宿主端口**：`deploy/.env` 的 `LIBMSSDK_BIND` 控制的是宿主把 8899 发布到哪张网卡，
  默认 `run.sh` 生成的是 `0.0.0.0`，也就是明文端口直接对外可达 —— 挂上反代之后要改成
  `127.0.0.1`，否则「在 HTTPS 后面」只是错觉。容器内进程仍绑 `0.0.0.0`，代理经服务名访问不受影响。
  这一条同时是限流按真实客户端分桶的前提：见第 3 节的 `LIBMSSDK_TRUST_PROXY`。
## 9. 升级检查清单

1. 确认反向代理/客户端把非 2xx 当成「可重试与否」的信号，而不是一律当上游故障。
2. 如果之前把 502 配成告警，改成 500 `SIGNER_UNAVAILABLE` / `INTERNAL_ERROR`。
3. 多进程部署时给每个 `serve` 进程留出内存：每个 worker 都要加载一份原生模块。
4. 绑定非回环地址的部署必须设置 `LIBMSSDK_TOKEN`，否则服务会拒绝启动。
5. 挂反向代理的部署同时做两件事：`LIBMSSDK_TRUST_PROXY=1`（并确认代理会重写
   `X-Forwarded-For`），以及把宿主端口绑到 `127.0.0.1` 只让代理能连 —— 否则直连请求可以伪造 XFF
   自选分桶键，也等于绕过了 TLS。Docker 部署的 compose 已透传该变量；不挂反代就接受所有客户端
   共用一个桶。
6. 全文搜一遍脚本与文档里的 `/probe`、`/track/stream`、`/config`：前两个在弃用期回带信号的
   404（下一版本 410），第三个直接 404。改成命令行 `probe` / 客户端自己判断 / 读身份文件；
   `trustProxy` 的运行时视图改看 `GET /stat`。
7. 自己维护探针的话：「进程在不在」用 `/livez`，「能不能干活」用 `/readyz`；Docker 健康检查
   已改指 `/readyz`（间隔 5 秒、超时 2 秒，起始宽限期仍 180 秒）：「间隔 + 超时」必须小于排空窗口，
   否则停止期间可能一次都读不到那个 503；自己维护探针时也照这条对齐。
8. 决定上 TLS 的，配置抄 `deploy/reverse-proxy/`，然后**换一个新的 `LIBMSSDK_TOKEN`**。
9. 出问题时先看 `GET /stat`；调参期可把 state 目录下的 `rate-limit.mode` 写成 `log`。
10. 发版到「旧诊断端点改 410」那一版的人：先看一眼 `src/endpoints.mjs` 里的 `SUNSET_HTTP_DATE`。
    要是这一版实际晚于它，先把 `DEPRECATED_AT` / `SUNSET_HTTP_DATE` 这一对推到新版本之后，再改 410 ——
    头里写着「早已到期」比不发这个头更糟（用例把两个时刻的先后关系钉死了，改一个就得改另一个）。
11. 滚动升级前核对停止宽限期：容器已设 `stop_grace_period: 30s` 与 8 秒排空窗口；计划任务
    （`schtasks /end`）拿不到信号，要优雅停止就换 nssm / Windows 服务，`/end` 后补 `taskkill /T`。
