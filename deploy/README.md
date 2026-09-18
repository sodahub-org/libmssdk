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
   必须是随机长串——**这个 token 等于签名能力**。
2. 前面挂一个反向代理做 HTTPS（Caddy 最省事）：

   ```caddyfile
   signer.example.com {
       reverse_proxy 127.0.0.1:8899
   }
   ```

3. 只放行 `/sign`。`/probe`、`/track/stream` 会拿你的服务去打官方接口，公网部署
   建议在反代里挡掉：

   ```caddyfile
   signer.example.com {
       @deny not path /sign /healthz
       respond @deny 404
       reverse_proxy 127.0.0.1:8899
   }
   ```

4. 国内主机用 80/443 需要备案，可以先跑非标端口（如 8443）验证。

## 安全提醒（重要）

* **调用方会把 cookie 发给签名服务**：签名覆盖「URL + 全部请求头」，cookie 是其中
  之一。多人共用时，服务方（也就是你）能看到使用者的登录态。要么明确告知使用者，
  要么让每个人本地跑一份（同样的镜像，`docker run -t -p 127.0.0.1:8899:8899 …`）。
* **日志已脱敏**：只记请求形状与签名长度，不落 cookie / X-Helios / X-Medusa。
* 公开端点等于公开「应用签名能力」，建议 token + 限速 + 不公开地址。

## 其他

| 事项 | 说明 |
| --- | --- |
| 设备身份 | 首次启动随机生成 `device_id`/`iid`/`fp`，落在 volume `libmssdk-data` 的 `identity.json`，容器重建不变；想重置换新 volume，想钉死用 `LIBMSSDK_DEVICE_ID` |
| ARM 主机 | 镜像里是 x86_64 的 Wine + Windows Node，ARM 机器上要靠 QEMU 模拟（很慢）；建议部署到 x86_64 主机 |
| Node 版本 | 钉 `20.18.0`（`24` 在 Wine 下 CSPRNG 断言崩溃） |
| 日志 | JSON 行输出到 stdout：`docker compose logs -f` |
| 端口 | 容器内固定 8899，宿主机端口由 `deploy/.env` 的 `LIBMSSDK_PORT` 决定 |
