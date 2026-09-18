# AGENTS.md — libmssdk 开发约定

面向在本仓库工作的 AI agent / 协作者。动代码前先读本文件。

## 项目定位

`libmssdk` 是汽水音乐应用签名服务的本地包装器。它调用用户自己提供的
`bdms.node`（及其依赖 `metasecml.dll`），生成 `X-Helios` / `X-Medusa`，
供 [libresoda](https://github.com/sodahub-org/libresoda) 等客户端使用。

官方二进制不在仓库中，也不得提交或再分发。用户必须从自己安装的客户端中提供。

## 目录

```text
vendor/soda-music/   用户本地放置 bdms.node + metasecml.dll 的位置（二进制被忽略）
data/                运行期状态（identity.json，勿提交）
deploy/              Docker 一键部署（Wine + Windows 版 Node）
src/config.mjs       环境变量、客户端目录、bdms 路径、身份状态
src/bdms.mjs         bdms.node 加载 / init / 签名；headers 展开和解析纯函数
src/contract.mjs     SignRequest 校验和 SignResponse 组装
src/probe.mjs        track_v2 真机自检和整曲 / 试听判定
src/server.mjs       HTTP 路由
src/index.mjs        CLI：serve / bridge / selftest / probe / config
test/                使用 mock-bdms 的离线测试
docs/CONTRACT.md     服务契约
docs/DEPLOY-WINDOWS.md Windows 部署
deploy/README.md     Docker 部署
```

## 硬性约定

1. **官方二进制不入库**：`bdms.node`、`metasecml.dll` 不提交、不发布、不再分发。
2. **签名覆盖 URL + 全部请求头**：`/sign` 收到的 headers 必须是调用方真实发送的一份。
3. **`x-ss-stub` 是 body 的 MD5 大写**，既是签名输入，也要随请求发送。
4. **设备成套**：`device_id` / `iid` / `fp` 必须与 `bdms.init({ deviceId })` 一致。
5. **空响应不代表接口故障**：签名不符时服务端可能返回 HTTP 200 + 0 bytes。
   是否成功必须用 `/probe` 的 `fullTrack` 判定。
6. **不记录凭据**：日志只允许请求形状、签名长度和脱敏设备号。
   Cookie、`X-Helios`、`X-Medusa` 一律不落盘。
7. **零运行时依赖**：服务只用 Node 内置模块；测试也使用 mock。
8. **鉴权默认可用**：设置 `LIBMSSDK_TOKEN` 后所有 POST 路由都需要 Bearer Token。
9. **改签名或部署逻辑必须测试**：至少 `npm test`；有原生模块时再跑
   `node src/index.mjs selftest` 和真机 `/probe`。

## 开源边界

源码使用 MIT。`vendor/soda-music/` 下的官方二进制专有、被 Git 忽略，不随仓库分发。
公开仓库不得包含用户 Cookie、Token、抓包签名值、真实设备指纹或本机路径。
