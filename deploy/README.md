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
`event=dispatcher` 写明实际值与来由。worker 预热完成前 `/healthz` 返回 503，预热完成后才回 200。
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

1. `deploy/.env` 里 `LIBMSSDK_BIND=0.0.0.0`（默认就是），并且 `LIBMSSDK_TOKEN`
   必须是随机长串——**这个 token 等于签名能力**。没配 token 时服务会拒绝启动。
2. 前面挂一个反向代理做 HTTPS（Caddy 最省事）：

   ```caddyfile
   signer.example.com {
       reverse_proxy 127.0.0.1:8899
   }
   ```

   反向代理会改掉 TCP 对端地址，所有客户端会被算成同一个桶。要让限流按真实客户端分桶，
   在 `deploy/.env` 里加 `LIBMSSDK_TRUST_PROXY=1`，并确认反代会重写 `X-Forwarded-For`
   （Caddy 默认会）。没开时只认 TCP 对端，这是安全默认。

3. 只放行 `/sign`、`/healthz`（需要的话再加 `/stat`）。`/probe`、`/track/stream` 会拿你的
   服务去打官方接口，公网部署建议在反代里挡掉：

   ```caddyfile
   signer.example.com {
       @deny not path /sign /healthz /stat
       respond @deny 404
       reverse_proxy 127.0.0.1:8899
   }
   ```

4. 国内主机用 80/443 需要备案，可以先跑非标端口（如 8443）验证。

## 安全提醒（重要）

* **调用方会把 cookie 发给签名服务**：签名覆盖「URL + 全部请求头」，cookie 是其中
  之一。多人共用时，服务方（也就是你）能看到使用者的登录态。要么明确告知使用者，
  要么让每个人本地跑一份（同样的镜像，`docker run -t -p 127.0.0.1:8899:8899 …`）。
* **日志已脱敏**：只记请求形状、签名长度与脱敏设备号/IP，不落 cookie / X-Helios / X-Medusa。
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
