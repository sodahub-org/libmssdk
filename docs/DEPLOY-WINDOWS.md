# 在 Windows 上部署 libmssdk

> 没有 Windows 主机？可以用容器部署（Wine + Windows 版 Node，任意 x86_64 Linux）：
> 见 [`../deploy/README.md`](../deploy/README.md)。

## 0. 前置条件

| 需求 | 说明 |
| --- | --- |
| Node.js 18+ | 唯一必装项。从你的客户端复制文件后，实测 v24 可直接加载原生模块 |
| 签名模块 | 由你提供：从自己安装的汽水客户端复制 `bdms.node` + `metasecml.dll` 到 `vendor/soda-music/` |
| 设备身份 | **自动生成**：首次运行随机生成 16 位 `device_id`/`iid`/`fp` 并写入 `data/identity.json`，跨重启复用 |
| 账号 Cookie | 可选但 VIP 曲目必需；用 libresoda 的扫码登录或从客户端抓 |

> `vendor/soda-music/` 里的两个官方文件被 `.gitignore` 忽略，不要提交或分发。
> 也可以不复制文件，直接设 `LIBMSSDK_CLIENT_DIR` 指向客户端版本目录。

## 1. 安装与自检

```powershell
git clone <repo-url> C:\libmssdk
cd C:\libmssdk

$env:LIBMSSDK_TOKEN = "<随机串>"     # 唯一建议设置的变量

node src/index.mjs config      # 打印配置摘要（设备号脱敏）
node src/index.mjs selftest    # bdms.node 是否可加载、能否出签名
```

`selftest` 期望：

```json
{
  "bdmsModule": "C:\\libmssdk\\vendor\\soda-music\\bdms.node",
  "bundledBdms": "C:\\libmssdk\\vendor\\soda-music\\bdms.node",
  "clientDir": "(未找到)",
  "deviceId": "512***907",
  "identity": "state (C:\\libmssdk\\data\\identity.json)",
  "signOk": true,
  "signatureLengths": { "X-Helios": 48, "X-Medusa": 872 }
}
```

`clientDir: "(未找到)"` 是正常的 —— 说明这台机器没装客户端，签名模块来自用户提供的 vendor 目录。
设备号只在首次运行时生成，之后一直复用；换机器/删掉 `data/` 才会换。

## 2. 真机自检（关键一步）

```powershell
node src/index.mjs probe --track 7501674235158431760 --cookie "sessionid_ss=…; uid_tt_ss=…"
```

- `"fullTrack": true` → 成功（VIP 曲目也能拿到整曲，`gears` 里会出现 `highest` / `lossless`）
- `"fullTrack": false` → 见下表

| 输出线索 | 含义 |
| --- | --- |
| `accepted: false` + `空响应` | 签名没被接受：`device_id` 与签名器不一致，或 `headers` 与实际发送的不一致 |
| `streamDurationSeconds ≈ 30` | 只拿到试听：账号没有该曲目整曲权益（或 Cookie 失效） |
| 502 + `未找到 bdms.node` | `LIBMSSDK_CLIENT_DIR` 指到了错误目录（应指向含 `resources` 的版本目录） |

## 3. 常驻服务

```powershell
# 方式 A：nssm（推荐）
nssm install libmssdk "C:\Program Files\nodejs\node.exe" "C:\libmssdk\src\index.mjs serve"
nssm set libmssdk AppEnvironmentExtra LIBMSSDK_TOKEN=…
nssm start libmssdk

# 方式 B：计划任务（跑一个带环境变量的批处理，避免命令行里塞引号）
#   serve.cmd 里只需要 set "LIBMSSDK_TOKEN=…" 一行
schtasks /create /tn libmssdk /sc onstart /ru SYSTEM /rl HIGHEST ^
  /tr "C:\libmssdk\serve.cmd"
```

默认只监听 `127.0.0.1:8899`。跨机访问**优先用 SSH 隧道**：

```bash
# Linux 侧
ssh -N -L 18899:127.0.0.1:8899 win-box
export QISHUI_SIGNER_URL=http://127.0.0.1:18899/sign
```

确需监听局域网时，务必同时设置 `LIBMSSDK_TOKEN` 并用防火墙限制来源网段。

服务以 SYSTEM/服务账号运行时，若仓库目录不可写，用 `LIBMSSDK_STATE_DIR`
指一个可写目录放 `identity.json`（否则设备号会在内存里临时生成、重启就变）。

## 4. 用 Electron 跑（Node ABI 不匹配时）

个别客户端版本的 `bdms.node` 是按 Electron ABI 编译的，用系统 Node 加载会报
`The specified module could not be found` / ABI 不匹配。此时改用客户端自带的
Electron：

```powershell
& "$env:LOCALAPPDATA\Programs\Soda Music\3.7.0\SodaMusic.exe" `
  --no-sandbox --headless `
  "C:\libmssdk\src\index.mjs" serve
```

（Electron 会把第一个非开关参数当作入口脚本；若客户端版本不接受该用法，
退回方式 A/B，或把 `bdms.node` 的调用放进客户端支持的插件目录。）

## 5. 与 libresoda 联调

```bash
# Linux 侧
cd libresoda
QISHUI_SIGNER_URL=http://127.0.0.1:18899/sign \
SODA_DEVICE_ID=<device_id> SODA_IID=<iid> SODA_FP=<fp> \
  cargo test --offline -- --ignored --nocapture stream_access_diagnose_online

# 期望
# 曲目 7304719759323564095: 整曲时长 180s，来源 pc，音质 lossless(无损)，… 试听 false
# ✓ 整曲流获取成功（这是 VIP 取流的最终验收条件）
```

## 6. 运维要点

- **设备指纹会失效**：换客户端版本/重装/换机后要重新抓 `device_id`
  （`/healthz` 的 `deviceId` 只做脱敏展示，便于核对是否换过）。
- **Cookie 会过期**：`/probe` 会明确告诉你"只拿到试听"。
- **日志**：stdout 是 JSON 行，只含请求形状与签名长度；可直接接文件/日志系统。
- **安全**：服务等于你账号的取流能力，不要公网暴露、不要分享 token。
