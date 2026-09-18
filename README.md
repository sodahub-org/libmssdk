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
  → libmssdk 调用 bdms.node
  → 返回 { X-Helios, X-Medusa }
  → 客户端用这对请求头发起真实请求
```

签名覆盖 URL 和全部请求头，因此 `/sign` 收到的 headers 必须是实际要发送的那一份。

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
| `LIBMSSDK_STATE_DIR` | 自动生成设备身份的保存目录 |

Cloudflare Workers 不能运行 `bdms.node` / `metasecml.dll`，因此不能承载本服务的签名
执行层。Worker 只能作为鉴权、限流或转发网关。

## API

| 路由 | 说明 |
| --- | --- |
| `GET /healthz` | 健康状态，不泄露凭据 |
| `GET /config` | 配置摘要和脱敏设备号（需要 Token） |
| `POST /sign` | `{ url, method, headers, body }` → 签名请求头 |
| `POST /probe` | 构造 `track_v2` 请求并判断整曲 / 试听 |
| `POST /track/stream` | `/probe` 的别名 |

请求 / 响应契约见 [`docs/CONTRACT.md`](docs/CONTRACT.md)。

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

CI 使用 mock 签名模块，不依赖官方二进制。

## 许可与合规

`src/`、`deploy/`、`test/` 和文档源码使用 MIT，见 [`LICENSE`](LICENSE)。

`bdms.node` 和 `metasecml.dll` 来自汽水官方客户端，**不属于 MIT 授权，不得再分发**。
本项目仅供个人自用；不要用于公共签名代理、批量抓取、绕过权益限制或分发凭据。
