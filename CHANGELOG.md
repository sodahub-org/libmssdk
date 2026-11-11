# 变更日志

本文件记录 libmssdk 对外可观察的变化：新增了什么、哪些行为变了、什么被拿掉了。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按
[语义化版本](https://semver.org/lang/zh-CN/) 的 0.x 惯例：破坏性变更走次版本号，所以这一批
变化是 **0.2.0**，不是 0.1.1。

本文件只回答「哪一版改了什么」；为什么改、升级时具体要动哪一步，见
[`docs/UPGRADING.md`](docs/UPGRADING.md)。两份说法如果冲突，以 `UPGRADING.md` 为准，并回来修这里。

## [0.2.0] - 2026-11-11

**破坏性版本。** 三件事会直接影响已有部署：默认多进程、失败状态码全换、三个诊断端点从 HTTP 面下线。
从 `0.1.x` 升级之前，请先读 [`docs/UPGRADING.md`](docs/UPGRADING.md)，尤其是第 9 节的升级检查清单。

客户端契约这次只是服务端先落地：要让它真正对用户生效，客户端仓库（[sodahub-org/sodam#103](https://github.com/sodahub-org/sodam/issues/103)）
还需要跟着改。

### 新增

- `GET /stat` 诊断端点：活跃限流桶数、允许 / 拒绝 / 驱逐计数、队列深度、worker 数、
  `trustProxy` 的当前值，以及拒绝次数最多的几个桶（最多 5 个）。地址一律脱敏；不鉴权、
  不参与限流计数、不打访问日志，预热期间也能回答。`/config` 删掉之后，`trustProxy` 的运行时视图落在这里。
- `GET /livez`：恒 200 的存活探针，不查依赖、不做计算。
- 默认按 IP 限流：分桶键是 TCP 对端地址（IPv4 单地址、IPv6 按 /64），默认持续 0.5 次/秒、突发 12、
  桶总数封顶 4096；超限回 429 `RATE_LIMITED`，`Retry-After` 是下次可请求时刻向上取整、最少 1 秒。
  只有显式 `LIBMSSDK_TRUST_PROXY=1` 才读 `X-Forwarded-For` 的最右一跳。
- 运行时可把 state 目录下的 `rate-limit.mode` 写成 `enforce` / `log` / `off`，约 2 秒内生效；
  文件不存在时用 `LIBMSSDK_RATE_LIMIT_MODE`（默认 `enforce`）。
- 排队与退避信号：并发超过空闲 worker 时请求排队，没有就绪 worker 或队列已满立即回 503 `BUSY`，
  已入队请求超过等待预算（`LIBMSSDK_WAIT_BUDGET_MS`，默认 5000）也是 503 `BUSY`；两种都在响应头与
  响应体各写一份 `Retry-After: 1`。签名接口没有副作用，可以安全按这个时长重试。
- 能直接用的反向代理配置：[`deploy/reverse-proxy/Caddyfile`](deploy/reverse-proxy/Caddyfile)（域名可解析
  时自动签发并续期证书）、[`deploy/reverse-proxy/nginx.conf`](deploy/reverse-proxy/nginx.conf)、
  以及容器形态叠一层的 [`deploy/docker-compose.proxy.yml`](deploy/docker-compose.proxy.yml)。
- 容器收尾的独立触发源：`deploy/entrypoint.sh` 把 `docker stop` 写成 state 目录下的 `closing.flag`
  （每轮一个随机 token），服务轮询到后走完整收尾；配合 `LIBMSSDK_DRAIN_DELAY_MS` 的排空窗口，
  先让探针读到 503 再停监听（compose 已设 8 秒，配 `stop_grace_period: 30s`）。
- `deploy/run.sh` 的部署前拦截：填了 `SIGNER_HOSTNAME`，或打开了 `LIBMSSDK_TRUST_PROXY`，
  而 `LIBMSSDK_BIND` 不是回环时直接退出，并点名触发的变量与改法（逃生舱 `LIBMSSDK_ALLOW_PUBLIC_HTTP=1`）。
- `deploy/run.sh` 会在构建前停下并说清写法：`.env` 里 `KEY = value`（等号带空格）、
  `export KEY = value`、`KEY: value`（YAML 式冒号）、以及值里有空格却没加引号这四种过去被 bash
  当成「没设」、compose 却照着绑定的写法。`.env` 是 CRLF 时先剥掉值里的 `\r` 再判断。

### 变更

- **破坏性** —— 默认启动多个进程。`node src/index.mjs serve` 由主进程独占端口、解析 HTTP、排队，
  每个 worker 进程只负责调一次 `bdms.node` 算签名。worker 数按绑定地址推导，环境变量始终优先：
  回环地址 1 个，非回环地址取 `availableParallelism() / 2` 的 75%，`LIBMSSDK_WORKERS` 按设置值。
  启动日志的 `event=dispatcher` 写明实际值与来由，`event=serve` 写 `workers` 与实际监听地址。
  进程数变化不需要改客户端，但多进程部署要给每个进程留出内存：每个 worker 都加载一份原生模块。
- **破坏性** —— 失败状态码全换。`/sign` 按「时间能否解决」分类：400 `INVALID_REQUEST`、
  401 `UNAUTHORIZED`、429 `RATE_LIMITED`、503 `BUSY`、500 `SIGNER_UNAVAILABLE`、
  500 `INTERNAL_ERROR`。**502 不再出现在任何出口。** 按 502 做重试或告警的调用方需要改判据。
- **破坏性** —— 健康检查拆成两个语义不同的端点：`/livez` 恒 200（进程还在不在），
  `/readyz` 至少要有一台 worker 就绪**且**不在收尾过程中才 200（能不能干活）；未就绪回 503 +
  `ready: false`，不带 `Retry-After` 也不带原因码。`/healthz` 保留为 `/readyz` 的别名，回同一份内容
  —— 但它的语义随之从「进程活着」变成「能干活」，已有的编排配置不改也能用，探针判据要自己核对。
  回包相对旧的 `/healthz` 少了 `bdmsAvailable`（它量的是「主进程看得到模块文件吗」，而签名发生在
  worker 里）。队列饱满程度不进就绪判定：过载时把自己从上游摘掉只会更忙，过载信号走 503 `BUSY`。
- **破坏性** —— 鉴权收紧：绑定非回环地址（`0.0.0.0`、`::`、局域网 IP 等）且没设 `LIBMSSDK_TOKEN`
  时**拒绝启动**，并在日志里写明原因。绑定回环（`127/8`、`::1`、`localhost`）才允许无令牌访问。
- 收尾序列固定下来：先把 `/readyz` 改口 → 排空窗口 → 停监听 → 等在飞与排队的请求收完 → 收 worker。
  `SIGTERM` / `SIGINT` 是第一件事的触发源，容器形态改用 `closing.flag`（见「新增」）。
- `node src/index.mjs config` / `selftest` 的输出，以及 `bridge` / `probe` 失败时的 stderr，
  默认把 `bdmsModule`、`clientDir`、身份文件路径与报错里的本机路径换成 `(本机路径)`；要排查具体文件时加 `--verbose`。
- 显式 `LIBMSSDK_BDMS_MODULE` 拼错时，`serve` 现在在监听前退出，而不是起来后让每条 `/sign` 都回
  500 `SIGNER_UNAVAILABLE`（只查文件存在性，不查能否加载）。默认探测（客户端目录 / vendor）没找到
  模块时仍按原行为启动。
- `deploy/run.sh` 从这一版起自己判「上了反代却留着对外明文口」，不再只是文档里的一句话。

### 移除

- **破坏性** —— `POST /probe` 从 HTTP 面下线。本版本回 404，带 `Deprecation`（RFC 9745 的 `@<秒>`）
  与 `Sunset`、`code: "endpoint_removed"`，并写明替代命令；**下一版本才回 410**，两个版本都不退成静默 404。
  替代：本机跑 `node src/index.mjs probe --track <track_id>`（输出字段与之前一致，多一个脱敏 `deviceId`）。
- **破坏性** —— `POST /track/stream` 同样下线，弃用节奏与回执同上。替代：客户端用 `/sign` 取到签名头后
  自己请求上游，比较 `video_duration` 与 `track.duration`。
- **破坏性** —— `GET /config` 直接删除（本次就没了，所以不带到期头，但同样回「没有了 + 替代做法」，
  不是静默 404）。它明文返回整套设备身份：设备号看不点名设备号地调 `/sign` 的回包，整套身份看
  `data/identity.json` 或本机 `node src/index.mjs config`，`trustProxy` 改看启动日志与 `GET /stat`。
- **破坏性** —— `LIBMSSDK_ALLOW_ANONYMOUS` 不再有任何作用，已从配置里移除。
- `src/server.mjs` 里那份进程内 `/sign` 老路径退场：签名只有分发器一条路（主进程排队、worker 计算），
  主进程那份 signer 只给 `selftest` / `probe` / `bridge` 三个本地命令用。
