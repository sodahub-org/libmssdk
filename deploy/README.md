# deploy —— Docker 一键部署

在任意 x86_64 Linux 上用 Docker + Wine + Windows 版 Node 跑签名服务。
容器**不包含** `bdms.node` / `metasecml.dll`；你必须挂载自己安装的汽水客户端
版本目录，让 libmssdk 使用你自己提供的官方签名模块。

## 一键启动

```bash
cd deploy
./run.sh
```

脚本会：生成 `deploy/.env`（随机 token）→ 确认这份 `.env` 里脚本要用的每一行 bash 都读得进去 →
检查 `LIBMSSDK_CLIENT_DIR` → 检查「要挂反向代理却把宿主明文口开着」这一组合（第 2 步）→ 构建镜像 →
启动容器 → 等健康检查通过 → 打印客户端接入方式。首次构建要装 Wine，约 3–5 分钟。

容器默认绑定 `0.0.0.0`，所以会按物理核的 75% 拉起多个 worker；启动日志的
`event=dispatcher` 写明实际值与来由。worker 预热完成前 `/readyz` 返回 503，预热完成后才回 200；
`/livez` 是恒 200 的那个（只看进程在不在，不看能不能干活）。容器健康检查探的是 `/readyz`。
`/sign` 在没有就绪 worker（例如预热中）或队列满时**立即**回 503 `BUSY`；已入队的请求超过等待预算也回 503。两者都带
`Retry-After: 1`，不会再回 502。

从本版本起还默认按客户端地址限流：单 IP 持续 0.5 次/秒、突发 12，超限回 **429 `RATE_LIMITED`**，
`Retry-After` 是精确的下次可请求时刻向上取整（最少 1 秒）。`GET /stat` 能看到活跃桶数、
允许/拒绝计数、队列深度和 worker 数，地址脱敏，且它自己不过限流、不打访问日志。
调参期把数据卷里的 `rate-limit.mode` 写成 `log`（只记日志）或 `off`（关闭）即可，约 2 秒生效：

```bash
docker compose exec libmssdk sh -c 'echo log > /app/data/rate-limit.mode'
```

常用变体：

```bash
LIBMSSDK_SKIP_BUILD=1 ./run.sh     # 已经 docker load 过镜像，直接启动不重建
```

`.env` 里可以指定数据落盘位置（例如系统盘小的机器放数据盘）：

```bash
LIBMSSDK_DATA_PATH=/data/libmssdk/data   # 设备身份 identity.json
LIBMSSDK_WINE_PATH=/data/libmssdk/wine   # Wine prefix（约 1.5GB）

# 必需：指向你自己安装的汽水音乐版本目录（内含 resources/）
LIBMSSDK_CLIENT_DIR="/path/to/Soda Music/3.7.0"
```

## 停止与滚动升级

`docker stop` / `docker compose down` 先发 `SIGTERM`；`deploy/entrypoint.sh` **在 state 目录写
`closing.flag`**（`/app/data/closing.flag`），Node 侧轮询到它就走完整收尾：`/readyz` 先回 503，
排空窗口结束后才停监听，最后收 worker。

为什么不是把 `SIGTERM` 转成 `SIGINT`：真机实测（Wine 11 + Windows Node 20）入口确实收到了
`SIGTERM`、也发出了 `SIGINT`，但 Node 侧没有 `event=shutdown`，`/readyz` 没改口，容器最后被
SIGKILL。文件不经过 Wine 的信号语义，是可靠的那条路；`SIGINT` 只是留给别的 Wine 版本。

- **触发文件**：`closing.flag` 启动时会被清掉（持久化 state 卷不能把重启直接收掉），触发后不删
  （多个 serve 共用同一份 state 时，谁先删谁就吞掉别的进程的触发）。
- **排空窗口**：`deploy/docker-compose.yml` 把 `LIBMSSDK_DRAIN_DELAY_MS` 默认设成 8 秒（`deploy/.env`
  可覆盖，设 0 = 信号一到就停监听）；直接用 `docker run` 跑镜像时用的是代码默认值 0，探针可能只看到
  连接被拒。窗口只推迟「停监听」，不推迟「改口」——它的作用就是让探针真的读到 503。
  **窗口必须大于探针的「间隔 + 超时」**：镜像内 `HEALTHCHECK` 是 5 秒 + 2 秒，compose 的 8 秒窗口
  满足这条规则；自己维护探针时也按同一规则对齐。
  别把窗口当成「容器会被标成 unhealthy」的保证：`HEALTHCHECK` 带 `--retries=3`，单次 503 不会翻状态，
  `docker stop` 期间也没有编排器在读健康状态。窗口真正买到的是「第一次失败就摘流」的外部探针的摘流
  时间，以及日志里可读的形态。
- **停止宽限期**：compose 已设 `stop_grace_period: 30s`。排空窗口 + 在飞请求必须在这段时间内跑完，
  否则 Docker 会 `SIGKILL`，客户端看到的就不是 503 而是连接重置。
- **前面的反向代理/负载均衡要按 `/readyz` 摘流**，别等连接失败才发现实例下线；只靠 `docker stop`
  本身，摘流是来不及的。
- **硬杀不在承诺里**：`kill -9`、`docker rm -f`、超过宽限期的停止，都是「进程直接消失」，观察到的
  是连接被拒/重置。计划任务 `schtasks /end` 同样拿不到信号（`TerminateProcess`），要优雅停止请换
  nssm 或 Windows 服务，见 [`../docs/DEPLOY-WINDOWS.md`](../docs/DEPLOY-WINDOWS.md)。
- **启动中途被停**：从拉起 wine 到 Node 开始轮询 `closing.flag` 之间有一个短窗口。此刻还没有开始监听、
  也没有在飞请求，入口会直接结束，不会挂到宽限期。

## 客户端怎么用

```bash
export QISHUI_SIGNER_URL=https://signer.example.com/sign
```

`libresoda` 侧直接配两个环境变量即可（`soda::signature::HttpSignature::from_env()`
会读它们，非空 token 自动带上 `Authorization: Bearer …`）：

```bash
export QISHUI_SIGNER_URL=http://<签名服务>:8899/sign
export QISHUI_SIGNER_TOKEN=<上面生成的 token>
```

也可以显式写：`HttpSignature::new(url).with_token("<token>")`。

## 对外暴露（给多台机器/多个人用）

1. `deploy/.env` 里的 `LIBMSSDK_TOKEN` 必须是随机长串——**这个 token 等于签名能力**；
   绑定非回环地址又没配 token 时，服务直接拒绝启动（只有绑回环才允许无令牌访问）。
2. **挂上反向代理就把宿主明文口收掉**：`deploy/.env` 里写 `LIBMSSDK_BIND=127.0.0.1`。
   这个变量控制的是**宿主**上把 `LIBMSSDK_PORT`（默认 8899）发布到哪张网卡；容器内的进程始终监听
   `0.0.0.0`，所以代理经服务名 `libmssdk:8899` 照常访问，收紧的只是宿主那一侧。
   `run.sh` 首次生成的默认是 `0.0.0.0`，请按部署形态改。不收的后果：任何客户端都能绕过 443 直接打
   `http://<host>:8899/sign`，Bearer token 与请求里的 cookie 全走明文 —— 挂上反代之后人容易以为
   自己已经在 HTTPS 后面。这一条同时是下面第 3 步（按真实客户端限流）的前提。
   **这一步不再靠人读注释完成了**：`run.sh` 在构建与起容器之前自己检查 —— `.env` 里填了
   `SIGNER_HOSTNAME`，或打开了 `LIBMSSDK_TRUST_PROXY`（取值集合与服务里 `envFlag` 一致：`1`/`true`/
   `yes`/`on`，不分大小写；两者都等于声明「前面挂了同机反代」），而 `LIBMSSDK_BIND` 不是回环
   （`127/8` 的点分四段、`::1` 与它的方括号／全写形式、`localhost`）时直接退出，并点名触发的变量与改法。
   判据落在部署脚本侧而不是服务里：容器内的进程永远看到 `0.0.0.0`，在服务里判会把推荐的 Docker
   形态误判成违规。`.env` 里某一行如果 bash 压根读不进去，`run.sh` 也在起容器之前停下 —— 四种写法：
   等号前有空白（`LIBMSSDK_BIND = 0.0.0.0`，加 `export` 前缀同理）、等号后有空白、YAML 式的
   `LIBMSSDK_BIND: 0.0.0.0`（冒号那种 compose 认、bash 不认），以及形状没错但值里有空格却没加引号
   （`LIBMSSDK_CLIENT_DIR=C:\Program Files\…` 就是这么被 bash 整行丢掉的）。脚本读不懂这份配置时不替
   它担保 —— 带空格的值用双引号包住即可。这条管的是 `run.sh` 自己要用到的那几个变量，不只
   `LIBMSSDK_BIND`，且只看同一个键最后一次声明的那一行。
   逃生舱 `LIBMSSDK_ALLOW_PUBLIC_HTTP=1` 只适用于一种情形：**你故意同时保留对外的
   明文入口，且它在内网防火墙后面**。设了它 `run.sh` 放行，但在 stderr 留一句提醒 —— token 等价于
   签名能力，它与 cookie 走的都是明文。绕过 `run.sh` 直接敲 `docker compose -f ... -f ...` 的人
   不受这条检查保护，第 2 步本身照旧要自己做。
   （这条检查由 `npm test` 里的 [`../test/deploy-run-guard.test.mjs`](../test/deploy-run-guard.test.mjs)
   跑真实 `run.sh` 盯着。）
3. 反向代理会改掉 TCP 对端地址，所有客户端会被算成同一个桶。要让限流按真实客户端分桶，
   **同时**做两件事：

   - 第 2 步的 `LIBMSSDK_BIND=127.0.0.1` —— 让宿主端口只有本机反代能连；
   - `deploy/.env` 里 `LIBMSSDK_TRUST_PROXY=1`（compose 会透传进容器），并确认反代会重写
     `X-Forwarded-For`（Caddy 与 nginx 的例子都会）。

   只开 `TRUST_PROXY` 而宿主端口对外可达时，调用方可以绕过反代直连端口、自带伪造的
   `X-Forwarded-For` 自选分桶键，等于没有限流。这一条现在同样由 `run.sh` 拦住：`LIBMSSDK_TRUST_PROXY`
   打开（`1`/`true`/`yes`/`on`）配上非回环的 `LIBMSSDK_BIND` 直接拒启动（放行条件与逃生舱见第 2 步）。
   两个都不开时只认 TCP 对端，所有客户端会共用反代那一个桶（默认 0.5 次/秒、突发 12，阈值故意宽松）。
   其它 `LIBMSSDK_*` 调优变量不会自动进容器（compose 只透传上面列出的几项）；需要时在
   `docker-compose.yml` 的 `environment:` 里补同名项。
4. 前面挂一个反向代理做 HTTPS。仓库里给的是能直接用的配置，不用自己拼：

   | 形态 | 文件 | 起来的方式 |
   | --- | --- | --- |
   | Windows 裸机 | [`reverse-proxy/Caddyfile`](reverse-proxy/Caddyfile) | 设好 `SIGNER_HOSTNAME` 与 `LIBMSSDK_UPSTREAM`，`caddy run --config Caddyfile`（语法已由 CI 验过，见下） |
   | Docker（同主 compose 叠一层） | [`reverse-proxy/Caddyfile`](reverse-proxy/Caddyfile) + [`docker-compose.proxy.yml`](docker-compose.proxy.yml) | `docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d`（要 `SIGNER_HOSTNAME`） |
   | 已有 nginx 的 Linux / Docker 主机 | [`reverse-proxy/nginx.conf`](reverse-proxy/nginx.conf) | 放进 `conf.d/`，证书路径与 `server_name` 换成你自己的 |

   上面两份配置的语法由 CI 离线校验（`.github/workflows/ci.yml` 的 `reverse-proxy` 作业）：
   Caddyfile 用 `caddy:2.11.7-alpine` 跑 `caddy validate`（变量齐全、缺任意一个都跑，缺变量时报错要指到行），
   nginx.conf 用 `nginx:1.30.6-alpine` 跑 `nginx -t`（`http2 on;` 要求 nginx ≥ 1.25.1）。这就是「验过的版本」。
   注意 `docker-compose.proxy.yml` 里的 `image: caddy:2` 是浮动大版本：拉到更新的 2.x 后，建议按上面的
   命令自己再验一遍。
   CI 验的是**语法**；你上线要验的是域名解析与证书可达。改过文件，或你本机装的 Caddy / nginx 不是这两个
   版本时，仍要自己跑一次 `caddy validate` / `nginx -t`。本地复跑需要 Docker 与 openssl，命令见
   [`../tools/reverse-proxy-check.mjs`](../tools/reverse-proxy-check.mjs) 开头的说明。
   本文件里标成 `caddyfile` 的代码块（第 8 步那段路径白名单）也在同一个作业里：脚本取出每一段、当
   独立 Caddyfile 跑一遍 `caddy validate`，所以改那段同样要过这一关。

   域名能解析到这台机器时 Caddy 自己签、自己续，你不用碰证书文件。本仓库不自签证书那套教程
   （起一个本地 CA 再让每个客户端导入根证书）：客户端要么导入那个 CA、要么跳过校验（等于放弃
   TLS）、要么做证书固定，而最后一条在双方都没法强制升级的场景里是明确的反面教材。只有你自己
   用的话，走 SSH 隧道比自签更省事（见 `../docs/DEPLOY-WINDOWS.md`）。
   叠那一层还要在 `deploy/.env` 里加一行 `SIGNER_HOSTNAME=<对外域名>`（`run.sh` 生成的模板里注释着）。
5. **本服务进程内不做 TLS**，所以证书归代理。原因不是省事：证书续期意味着重启那个正握着
   `bdms.node` 的进程，而冷启动恰恰是最危险的一步（预热没完成时每个 `/sign` 都是 503）；
   进程内做 TLS 也没有任何办法照顾已经发布出去的老客户端。
6. **明文通道上 token 会泄露**，而它等价于签名能力。**上了 TLS 必须换一个新 token**：
   旧 token 已经在无数人的历史流量里出现过，换协议不等于换了凭据。
7. 「不重定向」说的是**签名服务自己的明文端口**：它继续完整服务，不改成跳转 —— 308 对不跟随
   重定向的客户端是直接失败，对已经拿到明文的请求又毫无增益。**代理自己的 80 端口不在这句话里**：
   Caddy 的自动 HTTPS 默认就在 80 上放一个到 443 的跳转，不跟随 308 的客户端用不了 80。真要让 80
   也只应 ACME 质询，在 Caddyfile 顶部全局块加 `auto_https disable_redirects`；这是你自己的改动，
   改完自己跑一次 `caddy validate`（仓库原样的语法已由 CI 验过）。nginx 那份只有 443 的 server block，
   80 上压根没监听。
8. 端点收拢之后反代里没什么必须挡的了：`/probe`、`/track/stream`、`/config` 已经不在 HTTP 上，
   那三条路径只回一句「没有了 + 改用哪个命令」，不签名也不出网。`/sign` 之外只剩 `/livez`、
   `/readyz`（`/healthz` 是别名）三个探针，加上部署者用的 `GET /stat`。
   这三条探针的清单以 `src/endpoints.mjs` 的 `PROBE_PATHS` 为准：`nginx.conf` 的免日志
   location、下面白名单和 Caddyfile 注释里的 `log_skip` 示例都照它写，新增别名时同步这三处
   （`npm test` 与 CI 的反代校验会核对）。
   Caddy 默认不写访问日志，三条探针同样不进取数日志；若你自己加了 `log`，要按 Caddyfile
   注释里的写法用命名 matcher 排除它们（`@probes path …` 加 `log_skip @probes`，`log_skip`
   只收一个参数）。
   `/stat` 不鉴权、地址已脱敏，但**计数会暴露使用情况**（桶数、允许/拒绝、队列深度），公网部署
   建议别让它经公网可达。想连这个一起收紧，就在反代里只放行签名、三个探针与三条已删端点的回执：

   ```caddyfile
   signer.example.com {
       @deny not path /sign /livez /readyz /healthz /probe /probe/ /track/stream /track/stream/ /config /config/
       respond @deny 404
       reverse_proxy {
           to {$LIBMSSDK_UPSTREAM}
       }
   }
   ```

   放这三条是为了保住回执，不是放行能力：它们只回一句固定的「没有了 + 改用哪个命令」，不签名、
   不出网、也不看凭据，`/stat` 仍留在被挡的一侧。把它们挡在代理层就成了裸 404 —— 没有
   `code: "endpoint_removed"`、没有 `replacement`，`/probe` 与 `/track/stream` 还会少掉
   `Deprecation` / `Sunset` 两个头（`/config` 本就没有这一对，它不是弃用期而是当场删除），
   正好毁掉 `../docs/UPGRADING.md` 里那段过渡。

   三条回执各写了带尾斜杠与不带尾斜杠两种，是因为 Caddy 的 `path` 是整段精确匹配、大小写不敏感，
   尾斜杠也算数（文档原话 `Slashes are significant`），所以 `/probe` 不覆盖 `/probe/`；而服务侧
   把 `/probe/` 认成同一条路由（`../src/endpoints.mjs`）。手敲的 curl 很容易多带一个尾斜杠，漏掉
   就又是一个裸 404。探针路径由编排器按固定值打，通常不带尾斜杠；你的探针若会带，照这个办法补
   一条 `/livez/` 之类。`/sign` 不用补：服务侧只认 `/sign`，`/sign/` 本来就是 404。

   nginx 那份示例（[`reverse-proxy/nginx.conf`](reverse-proxy/nginx.conf)）**不含路径白名单**：
   它的 `location /` 把全部路径都转给上游，三条回执照样到得了服务、由服务自己回答，但 `/stat`
   也因此经公网可达。随仓库的 `reverse-proxy/Caddyfile` 同样没有白名单 —— 默认两份都是全量转发，
   上面那段是可选收紧。要跟上面这样收紧，得把兜底的 `location /` 换成 `return 404`，再给清单里
   每条路径写一条精确匹配的 `location`（`= /probe` 与 `= /probe/` 各一条，其余同理）—— 只加
   `location` 而不动那个兜底块等于什么也没挡。那几条 `proxy_set_header` 现在只写在 `location /`
   里，新的 location 继承不到（nginx 只在某一层一条都没写时才整组继承上一层的），要提到 `server`
   一级或逐条重写；少了 `X-Forwarded-For`，开了 `LIBMSSDK_TRUST_PROXY=1` 之后所有客户端会缩成
   一个限流桶（见第 3 步与 `nginx.conf` 里的注释）。现成的 `= /livez` / `= /readyz` 也没带这几行，
   但限流只覆盖 `/sign`，探针不进取数桶，所以现在这样没问题。
   改完自己跑一次 `nginx -t`；仓库不随附这份收紧版，多出来的白名单同样得有人维护，而现成的这份
   是 CI 按原样验过的。

   在宿主机上直接看诊断：`curl http://127.0.0.1:<宿主机端口>/stat`（端口见 `deploy/.env` 的
   `LIBMSSDK_PORT`，默认 8899）。
9. 国内主机用 80/443 需要备案，可以先跑非标端口（如 8443）验证。

## 安全提醒（重要）

* **调用方会把 cookie 发给签名服务**：签名覆盖「URL + 全部请求头」，cookie 是其中
  之一。多人共用时，服务方（也就是你）能看到使用者的登录态。要么明确告知使用者，
  要么让每个人本地跑一份（同样的镜像，`docker run -t -p 127.0.0.1:8899:8899 …`）。
* **日志已脱敏**：只记请求形状、签名长度与脱敏设备号/IP，不落 cookie / X-Helios / X-Medusa。
* **token 走明文等于公开**：见上面第 6 步；上 TLS 之后换 token，别复用旧的，并按第 2 步把宿主
  明文端口收下来。
* 公开端点等于公开「应用签名能力」，建议 token + 限速 + 不公开地址。限流默认生效，
  但阈值故意宽松（共享出口后面几十个人共用一个地址），不能替代 token 与网络隔离。

## 其他

| 事项 | 说明 |
| --- | --- |
| 设备身份 | 首次启动用独占创建生成 `device_id`/`iid`/`fp`，落在 volume `libmssdk-data` 的 `identity.json`，容器重建不变、state 目录可用时多个进程同时首次启动也只有一份（Wine / 网络卷的慢 IO 下仍有残留窗口，见 `../docs/DEPLOY-WINDOWS.md`）；想重置换新 volume，想钉死用 `LIBMSSDK_DEVICE_ID` |
| worker 数 | 默认按绑定地址推导；容器里可用 `LIBMSSDK_WORKERS` 覆盖。每个 worker 加载一份原生模块，内存要留够 |
| 失败状态码 | 400/401/429/503/500；502 不再出现。完整表见 [`../docs/UPGRADING.md`](../docs/UPGRADING.md) |
| ARM 主机 | 镜像里是 x86_64 的 Wine + Windows Node，ARM 机器上要靠 QEMU 模拟（很慢）；建议部署到 x86_64 主机 |
| Node 版本 | 钉 `20.18.0`（`24` 在 Wine 下 CSPRNG 断言崩溃） |
| 日志 | 事件 JSON 行走 stdout，身份降级告警走 stderr；`docker compose logs -f` 两路都收 |
| 端口 | 容器内固定 8899，宿主机端口由 `deploy/.env` 的 `LIBMSSDK_PORT` 决定 |
