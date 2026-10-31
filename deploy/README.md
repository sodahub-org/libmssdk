# deploy —— Docker 一键部署

在任意 x86_64 Linux 上用 Docker + Wine + Windows 版 Node 跑签名服务。
容器**不包含** `bdms.node` / `metasecml.dll`；你必须挂载自己安装的汽水客户端
版本目录，让 libmssdk 使用你自己提供的官方签名模块。

## 一键启动

```bash
cd deploy
./run.sh
```

脚本会：检查 `LIBMSSDK_CLIENT_DIR` → 生成 `deploy/.env`（随机 token）→ 构建镜像 →
启动容器 → 等健康检查通过 → 打印客户端接入方式。首次构建要装 Wine，约 3–5 分钟。

容器默认绑定 `0.0.0.0`，所以会按物理核的 75% 拉起多个 worker；启动日志的
`event=dispatcher` 写明实际值与来由。worker 预热完成前 `/readyz` 返回 503，预热完成后才回 200；
`/livez` 是恒 200 的那个（只看进程在不在，不看能不能干活）。容器健康检查探的是 `/readyz`。
`/sign` 在没有就绪 worker（例如预热中）或队列满时**立即**回 503 `BUSY`；已入队的请求超过等待预算也回 503。两者都带
`Retry-After: 1`，不会再回 502。

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

1. `deploy/.env` 里 `LIBMSSDK_TOKEN` 必须是随机长串——**这个 token 等于签名能力**。
   同一个文件里的 `LIBMSSDK_BIND` 控制的是**宿主**上把 8899 发布到哪张网卡（容器内的进程固定绑
   `0.0.0.0`，见第 3 步）。`run.sh` 首次生成的默认是 `0.0.0.0`，也就是允许外部直连这个明文端口。
2. 前面挂一个反向代理做 HTTPS。仓库里给的是能直接用的两份配置，不用自己拼：

   | 形态 | 文件 | 起来的方式 |
   | --- | --- | --- |
   | Windows 裸机 | [`reverse-proxy/Caddyfile`](reverse-proxy/Caddyfile) | 设好 `SIGNER_HOSTNAME` 与 `LIBMSSDK_UPSTREAM`，先 `caddy validate`，再 `caddy run --config Caddyfile` |
   | Docker（同主 compose 叠一层） | [`reverse-proxy/Caddyfile`](reverse-proxy/Caddyfile) + [`docker-compose.proxy.yml`](docker-compose.proxy.yml) | `docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d`（要 `SIGNER_HOSTNAME`） |
   | 已有 nginx 的 Linux / Docker 主机 | [`reverse-proxy/nginx.conf`](reverse-proxy/nginx.conf) | 放进 `conf.d/`，证书路径换成你自己的 |

   域名能解析到这台机器时 Caddy 自己签、自己续，你不用碰证书文件。本仓库不自签证书那套教程
   （起一个本地 CA 再让每个客户端导入根证书）：客户端要么导入那个 CA、要么跳过校验（等于放弃
   TLS）、要么做证书固定，而最后一条在双方都没法强制升级的场景里是明确的反面教材。只有你自己
   用的话，走 SSH 隧道比自签更省事（见 `../docs/DEPLOY-WINDOWS.md`）。

3. **上了反向代理就把宿主明文口收掉**：`deploy/.env` 里写 `LIBMSSDK_BIND=127.0.0.1`。
   不收的话，任何客户端都能绕过 443 直接打 `http://<host>:8899/sign`，Bearer token 和请求里的
   cookie 全走明文——正是第 5 步说的那个泄露面，而挂上反代之后人容易以为自己在 HTTPS 后面。
   收紧只影响宿主上发布的那个地址；容器内进程仍绑 `0.0.0.0`，Caddy 经服务名 `libmssdk:8899`
   照常访问。**别指望在 `docker-compose.proxy.yml` 里再写一条 `ports:`**：compose 对 `ports` 是
   合并语义，会变成两条映射并存、明文口照开；真要在文件里改，得用 `!reset`（或 compose ≥ 2.24.4 的 `!override`）整段替换。
4. **本服务进程内不做 TLS**，所以证书归代理。原因不是省事：证书续期意味着重启那个正握着
   `bdms.node` 的进程，而冷启动恰恰是最危险的一步（预热没完成时每个 `/sign` 都是 503）；
   进程内做 TLS 也没有任何办法照顾已经发布出去的老客户端。
5. **明文通道上 token 会泄露**，而它等价于签名能力。**上了 TLS 必须换一个新 token**：
   旧 token 已经在无数人的历史流量里出现过，换协议不等于换了凭据。
6. 「不重定向」说的是**签名服务自己的明文 8899**：它继续完整服务，不改成跳转——308 对不跟随
   重定向的客户端是直接失败，对已经拿到明文的请求又毫无增益。**代理自己的 80 端口管不了**：
   Caddy 的自动 HTTPS 默认就在 80 上放一个到 443 的跳转（`docker-compose.proxy.yml` 的注释写的
   正是这件事），不跟随 308 的客户端用不了 80。真要让 80 也只应 ACME 质询，在 Caddyfile 顶部
   全局块加 `auto_https disable_redirects`，加完跑一次 `caddy validate`。nginx 那份只有 443 的
   server block，80 上压根没监听。
7. `/probe`、`/track/stream`、`/config` 已经从 HTTP 上收掉，反代里不必再专门挡它们：那三条路径
   现在只回一句「没有了 + 改用哪个命令」，不签名也不出网。`/sign` 之外只剩 `/livez`、`/readyz`
   （`/healthz` 是 `/readyz` 的别名）三个探针路径。
   叠反向代理那一层要在 `deploy/.env` 里加一行 `SIGNER_HOSTNAME=<对外域名>`（`run.sh` 生成的模板
   里注释着，取消注释即可）。
8. 国内主机用 80/443 需要备案，可以先跑非标端口（如 8443）验证。

## 安全提醒（重要）

* **调用方会把 cookie 发给签名服务**：签名覆盖「URL + 全部请求头」，cookie 是其中
  之一。多人共用时，服务方（也就是你）能看到使用者的登录态。要么明确告知使用者，
  要么让每个人本地跑一份（同样的镜像，`docker run -t -p 127.0.0.1:8899:8899 …`）。
* **日志已脱敏**：只记请求形状与签名长度，不落 cookie / X-Helios / X-Medusa。
* **token 走明文等于公开**：见上面第 5 条；上 TLS 之后换 token，别复用旧的，并按第 3 条把宿主明文端口收下来。
* 公开端点等于公开「应用签名能力」，建议 token + 限速 + 不公开地址。

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
