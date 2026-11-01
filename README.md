# libmssdk

> 汽水音乐 PC 客户端 `bdms.node` 的本地签名服务包装器。它把官方客户端自带的原生签名模块
> 暴露为 HTTP / stdio 接口，供 [libresoda](https://github.com/sodahub-org/libresoda)
> 调用并生成 `X-Helios` / `X-Medusa` 请求头。

> **重要**：本仓库不包含、也不再分发 `bdms.node` 或 `metasecml.dll`。
> 你必须从自己安装的汽水音乐客户端中复制这两个文件，且仅用于个人自用。
> 本项目与字节跳动、抖音或汽水音乐无关。

## 工作原理

```text
libresoda / 第三方客户端
  → POST /sign { url, method, headers, body }
  → 主进程排队，把请求交给空闲 worker
  → worker 调用 bdms.node，把签名结果交回主进程
  → 返回 { X-Helios, X-Medusa }
  → 客户端用这对请求头发起真实请求
```

一次签名会阻塞一个进程一百到几百毫秒，所以默认 `serve` 把「监听」和「计算」拆开：主进程独占
端口、排队并计时，worker 进程只算签名。worker 数按绑定地址推导（回环 1 个，对局域网开放时按
物理核的 75%），可用 `LIBMSSDK_WORKERS` 覆盖；启动日志会写明实际值与来由。

签名覆盖 URL 和全部请求头，因此 `/sign` 收到的 headers 必须是实际要发送的那一份。

## 整曲需要什么样的凭据

两样：**你自己客户端里的 `bdms.node`**，以及**这首歌本来就有整曲授权**。

不需要设备号与登录设备一致，也不依赖 Cookie——对照实验（同一个签名器、同一台机器）显示
随机设备号、服务落盘的固定设备号、甚至完全不带 Cookie，对同一首有授权的曲子都给出同样的
整曲 6 档；两首试听级曲目用两种设备号形状复测也都还是 30–60 秒单档。
所以决定权在曲目授权层，不在设备身份层。哪些组合还没测（Cookie 有无与真实登录设备在
*试听级*曲目上、Cookie 缺哪个字段）写在报告的第七节，那几条是本结论的边界。判据与复现步骤见
[`docs/INVESTIGATION-DEVICE-ENTITLEMENT.md`](docs/INVESTIGATION-DEVICE-ENTITLEMENT.md)。

这不是「可以绕过权益」：没有授权的曲目换什么凭据都还是试听。它只是说明
**应用签名本身就是取流凭据**，所以一台对多人开放的签名器，等于把你的出口 IP 和设备画像
押上去替所有人承担风控——不要公网裸奔，跨机访问走隧道。

## 你需要自己提供两个文件

官方签名模块不在仓库中，也不能由本仓库再分发。请从**你自己安装的**汽水音乐客户端
版本目录中找到并复制到同一个目录：

| 文件 | 作用 |
| --- | --- |
| `bdms.node` | 由 Windows / Electron 版 Node 加载，生成应用签名头 |
| `metasecml.dll` | `bdms.node` 依赖的库；必须与 `bdms.node` 同目录 |

常见位置：

```text
%LOCALAPPDATA%\Programs\Soda Music\<version>\resources\app.asar.unpacked\
%LOCALAPPDATA%\Programs\Soda Music\<version>\resources\app.asar.unpacked\mssdk\
```

建议放到仓库的私有目录：

```text
vendor/soda-music/bdms.node
vendor/soda-music/metasecml.dll
```

这两个文件已被 `.gitignore` 忽略，不要提交或分发给他人。

## Windows 快速开始

```powershell
git clone https://github.com/sodahub-org/libmssdk.git
cd libmssdk

# 复制你自己客户端中的 bdms.node / metasecml.dll 到 vendor/soda-music/
$env:LIBMSSDK_TOKEN = "<random-long-token>"
node src/index.mjs selftest
node src/index.mjs serve
```

默认监听 `127.0.0.1:8899`。跨机访问请使用 SSH 隧道或反代，并始终设置强 Token。

## Docker 部署

Docker 镜像使用 Wine 运行 Windows 版 Node。镜像不包含官方二进制；启动前必须把你自己
的汽水客户端版本目录挂载进容器：

```bash
cd deploy
export LIBMSSDK_CLIENT_DIR="/path/to/Soda Music/3.7.0"
./run.sh
```

`LIBMSSDK_CLIENT_DIR` 会以只读方式挂载到 `/client`，服务会自动查找：

```text
/client/resources/app.asar.unpacked/bdms.node
/client/resources/app.asar.unpacked/mssdk/bdms.node
```

`metasecml.dll` 必须能与找到的 `bdms.node` 一起加载。

## 配置

完整示例见 [`.env.example`](.env.example)。

| 变量 | 说明 |
| --- | --- |
| `LIBMSSDK_CLIENT_DIR` | 你的汽水客户端版本目录 |
| `LIBMSSDK_BDMS_MODULE` | 直接指定 `bdms.node`；同目录需有 `metasecml.dll` |
| `LIBMSSDK_DEVICE_ID` / `LIBMSSDK_IID` / `LIBMSSDK_FP` | 覆盖设备身份 |
| `LIBMSSDK_TOKEN` | HTTP 服务鉴权 Token |
| `LIBMSSDK_STATE_DIR` | 设备身份 `identity.json` 的保存目录；首次启动用独占创建写入，state 目录可用时多个进程同时首次启动也只生成一份（慢 IO 下的残留窗口见 `docs/DEPLOY-WINDOWS.md`） |
| `LIBMSSDK_IDENTITY_READ_BUDGET_MS` | 判定身份文件「损坏而非正在被写」的等待预算（默认 1000ms）；慢 IO 部署出现并发误判时可调大（降级路径阻塞随之变长），非正数或非法值回退默认 |
| `LIBMSSDK_WORKERS` | worker 进程数；不设则按绑定地址推导（回环 1 个，非回环按物理核的 75%） |
| `LIBMSSDK_WAIT_BUDGET_MS` | `/sign` 排队预算（默认 5000ms），超出回 503 `BUSY` |
| `LIBMSSDK_QUEUE_LIMIT` | 等待队列上限（默认 worker 数的 4 倍），排不下当场回 503 |
| `LIBMSSDK_WARMUP_BUDGET_MS` | 单台 worker 的预热预算（默认 30000ms）；超预算它保持未就绪且进程不退出 |
| `LIBMSSDK_DRAIN_DELAY_MS` | 收尾排空窗口（默认 0）：`markClosing()` 之后先保持监听，让 `/readyz` 的 503 被读到，再停监听；容器 compose 默认 8 秒并配 `stop_grace_period: 30s` |
| `LIBMSSDK_RATE_LIMIT_PER_SECOND` / `LIBMSSDK_RATE_LIMIT_BURST` | 单 IP 持续速率与突发额度（默认 0.5 次/秒、12） |
| `LIBMSSDK_RATE_LIMIT_MAX_BUCKETS` | 限流桶上限（默认 4096），满了挤掉最久没动的桶 |
| `LIBMSSDK_RATE_LIMIT_MODE` | 启动模式：`enforce` / `log` / `off`（默认 `enforce`） |
| `LIBMSSDK_RATE_LIMIT_MODE_FILE` | 运行时模式控制文件（默认 state 目录下的 `rate-limit.mode`）；写入后约 2 秒内切换 |
| `LIBMSSDK_RATE_LIMIT_MODE_POLL_MS` | 控制文件的轮询间隔（默认 2000ms） |
| `LIBMSSDK_TRUST_PROXY` | 设为 `1` 才信任 `X-Forwarded-For`（取最右一跳）；默认只认 TCP 对端地址。打开时服务端口须只对反代开放（绑 127.0.0.1） |

运行时把 state 目录下的 `rate-limit.mode` 写成 `enforce` / `log` / `off` 即可在不重启的情况下
切换限流模式（约 2 秒内生效）。

worker 重生退避（`LIBMSSDK_WORKER_RESPAWN_BASE_MS` / `LIBMSSDK_WORKER_RESPAWN_CAP_MS`）见
[`.env.example`](.env.example)。

Cloudflare Workers 不能运行 `bdms.node` / `metasecml.dll`，因此不能承载本服务的签名
执行层。Worker 只能作为鉴权、限流或转发网关。

## API

| 路由 | 说明 |
| --- | --- |
| `POST /sign` | `{ url, method, headers, body }` → 签名请求头（主进程排队、worker 计算） |
| `GET /livez` | 恒 200：只回答「进程还在不在」，不查任何依赖、不做任何计算 |
| `GET /readyz` | 至少一台 worker 就绪且不在收尾中才 200，否则 503。不泄露凭据 |
| `GET /healthz` | `/readyz` 的别名，留给已有的编排配置 |
| `GET /stat` | 诊断：活跃限流桶、允许/拒绝计数、队列深度、worker 数；地址一律脱敏、不过限流 |

HTTP 层只做签名与自身状态诊断：`/probe`、`/track/stream`、`/config` 三个端点已经拿掉了，真机自检是
命令行 `node src/index.mjs probe --track <track_id>`。为什么拿掉、以及旧端点在弃用期回什么，见
[`docs/UPGRADING.md`](docs/UPGRADING.md)。

请求 / 响应契约见 [`docs/CONTRACT.md`](docs/CONTRACT.md)。

### 行为变化（本版本）

- `/sign` 由主进程排队、worker 计算；没有就绪 worker 或队列已满时立即回 503，已入队的请求超过等待预算才回 503。
- 失败状态码按「时间能否解决」分类：400 / 401 / 429 / 503 / 500，**502 不再出现**。
- 只有服务忙（503 `BUSY`）与被限流（429 `RATE_LIMITED`）带 `Retry-After`。限流默认生效：
  按 TCP 对端地址分桶（IPv6 按 /64），超限回 429，等待时长是下次可请求时刻向上取整、最少 1 秒。
- 绑定非回环地址又没有设置 `LIBMSSDK_TOKEN` 时拒绝启动；绑定回环地址才允许无令牌访问（本机自用）。
- 新增 `GET /stat`：没有监控系统时用它看桶数、拒绝数、队列深度与 worker 数，地址全部脱敏。
- 健康检查拆成 `/livez`（恒 200）与 `/readyz`（跟 worker 就绪与收尾状态绑定），`/healthz` 是后者别名。
- 诊断端点收拢：`/probe` 与 `/track/stream` 只回带 `Deprecation` / `Sunset` 的回执（下一版本 410），
  `/config` 直接删除（它明文返回整套设备身份，而 #8 的 `trustProxy` 开关改由启动日志与 `/stat` 核对）。
  出网代码只剩 `src/probe.mjs` 一处。
- 交付能直接用的反向代理配置（`deploy/reverse-proxy/`）；进程内仍不做 TLS。

完整升级影响见 [`docs/UPGRADING.md`](docs/UPGRADING.md)。

## TLS：交给反向代理

进程内不做 TLS：证书续期意味着重启那个正握着 `bdms.node` 的进程，而冷启动恰恰是最危险的一步。
仓库里有能直接用的配置，覆盖 Windows 裸机与 Docker：

- [`deploy/reverse-proxy/Caddyfile`](deploy/reverse-proxy/Caddyfile) —— 域名可解析时自动签、自动续
- [`deploy/reverse-proxy/nginx.conf`](deploy/reverse-proxy/nginx.conf) —— 已有 nginx 的主机
- [`deploy/docker-compose.proxy.yml`](deploy/docker-compose.proxy.yml) —— 容器形态叠一层

三条必须知道：**明文通道上 token 会泄露**，而它等价于签名能力，所以上了 TLS 之后要换一个新 token
（旧 token 已经在历史流量里出现过，换协议不等于换凭据）；**上了反代就把宿主上的明文 8899 收到
127.0.0.1**，否则客户端能绕过 443 直连明文端口；「不做重定向」说的是服务自己的明文端口继续完整
服务，而**代理自己的 80 会跳 443**（自动 HTTPS 的默认行为，要关掉就加 `auto_https disable_redirects`）。

## 连接 libresoda

```bash
export QISHUI_SIGNER_URL="http://127.0.0.1:8899/sign"
export QISHUI_SIGNER_TOKEN="<random-long-token>"
```

`libresoda` 会自动在取流请求前调用签名服务。

## 部署

- Windows 主机：[`docs/DEPLOY-WINDOWS.md`](docs/DEPLOY-WINDOWS.md)
- Linux / Wine / Docker：[`deploy/README.md`](deploy/README.md)
- Cloudflare Workers：不支持作为签名执行层；只能做转发网关
- 运行环境边界与安全限制见 [`NOTICE.md`](NOTICE.md)

## 测试

```bash
npm test
```

CI 使用 mock 签名模块，不依赖官方二进制。默认路径的黑盒用例会真 fork worker，覆盖预热、并发重叠、
杀掉一台后其余继续服务，以及签名之外的端点（健康检查与旧诊断端点的弃用回执）仍挂在同一个监听上。

另有一条**手动执行**的部署形态验证（不进 `npm test`、不进 CI）：
`bash verify/wine-multi/run.sh` 检查 Docker + Wine 下多个进程能否同时工作，
没有 Docker 和凭据时可用 `--mode mock` 彩排，见 [`verify/wine-multi/README.md`](verify/wine-multi/README.md)。

## 许可与合规

`src/`、`deploy/`、`test/` 和文档源码使用 MIT，见 [`LICENSE`](LICENSE)。

`bdms.node` 和 `metasecml.dll` 来自汽水官方客户端，**不属于 MIT 授权，不得再分发**。
本项目仅供个人自用；不要用于公共签名代理、批量抓取、绕过权益限制或分发凭据。
