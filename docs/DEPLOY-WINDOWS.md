# 在 Windows 上部署 libmssdk

> 没有 Windows 主机？可以用容器部署（Wine + Windows 版 Node，任意 x86_64 Linux）：
> 见 [`../deploy/README.md`](../deploy/README.md)。

## 0. 前置条件

| 需求 | 说明 |
| --- | --- |
| Node.js 18+ | 唯一必装项。从你的客户端复制文件后，实测 v24 可直接加载原生模块 |
| 签名模块 | 由你提供：从自己安装的汽水客户端复制 `bdms.node` + `metasecml.dll` 到 `vendor/soda-music/` |
| 设备身份 | **自动生成**：首次运行用独占创建生成 16 位 `device_id`/`iid`/`fp` 并写入 `data/identity.json`，跨重启复用；多个进程同时首次启动也只生成一份 |
| 账号 Cookie | 由调用方随请求带来带去，本服务不存。注意它**不是整曲的开关**：实测有授权的曲目在完全不发 Cookie 时也给出整曲 6 档；决定整曲与否的是曲目授权（未验证的组合列在调查报告第七节） |

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
| `streamDurationSeconds ≈ 30` | 只拿到试听：先换一首已知能整曲的曲子复测——实测同一份设备号在别的曲目能拿到整曲，所以别先怀疑设备号。Cookie 有无、真实登录设备这两条在试听级曲目上还没测（见 [`INVESTIGATION-DEVICE-ENTITLEMENT.md`](INVESTIGATION-DEVICE-ENTITLEMENT.md) 第七节） |
| 500 `SIGNER_UNAVAILABLE` / `未找到 bdms.node` | `LIBMSSDK_CLIENT_DIR` 指到了错误目录（应指向含 `resources` 的版本目录） |

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

`serve` 默认会拉起 worker 进程：绑定 `127.0.0.1` 时 1 个；绑定局域网地址时按物理核的 75%
（`availableParallelism() / 2` 估算）。用 `LIBMSSDK_WORKERS` 可以钉死数量。启动日志的
`event=dispatcher` 写着实际值与来由，`event=serve` 写着监听的 `workers`。

预热期间（首次 `bdms.init`，通常几秒）`GET /healthz` 返回 503，预热完成后才回 200；
`/sign` 在没有就绪 worker（例如预热中）或队列满时**立即**回 503 `BUSY`，已入队的请求超过等待预算也回 503；两者都带
`Retry-After: 1`。这不影响 `nssm`/计划任务：
服务进程本身已经起来了，只是还没能接流量。

从本版本起还默认按客户端地址限流（0.5 次/秒、突发 12）：超限回 **429 `RATE_LIMITED`**，
`Retry-After` 是精确的下次可请求时刻向上取整（最少 1 秒）。`GET /stat` 可看活跃桶数、
允许/拒绝计数、队列深度与 worker 数；地址脱敏，该端点不鉴权、不过限流。
若前面挂了同机反向代理，设 `LIBMSSDK_TRUST_PROXY=1` 后务必让服务端口只对反代开放
（Windows 上绑 `127.0.0.1`），否则可绕过反代伪造 `X-Forwarded-For`、自选分桶键。

默认只监听 `127.0.0.1:8899`。跨机访问**优先用 SSH 隧道**：

```bash
# Linux 侧
ssh -N -L 18899:127.0.0.1:8899 win-box
export QISHUI_SIGNER_URL=http://127.0.0.1:18899/sign
```

确需监听局域网时，必须设置 `LIBMSSDK_TOKEN`（否则 `serve` 拒绝启动），并用防火墙限制来源网段。

服务以 SYSTEM/服务账号运行时，若仓库目录不可写，用 `LIBMSSDK_STATE_DIR`
指一个可写目录放 `identity.json`。目录不可用时设备号只在内存里、重启就变，
启动日志会留一条 `event=identity` 的告警，`reason` 是六种之一：
`state-dir-unusable`（建不出目录）、`create-failed`（写不下去）、`unconfirmed`（写得下去读不回来）、
`unreadable`（读不动）、`stuck`（坏文件挪不动）、`churning`（内容一直在变）；
`node src/index.mjs config` 里 `identity.persisted` 为 `false` 说的是同一件事。

`identity.json` 里的内容读不出合法设备号时，服务把它挪到 `identity.json.corrupt`
（保留证据，只留最近一份）并重建一个新设备号，日志留一条 `reason=rebuild` 的告警。
格式合法的文件不会被重建 —— 给已经存在的身份「纠错」等于再换一张脸。校验只看
`device_id` 的格式，`iid` / `fp` 缺失或不同不会触发重建。

残留窗口（慢 IO）：判「没写完」还是「真坏了」靠的是「连续两次读到同一份内容 + 等待预算」这个
时间启发式，它假设赢家能在预算内写完。在 Wine / Docker 数据卷 / 网络卷 / 杀软扫描下，赢家可能
在 `open` 之后被卡住超过 `LIBMSSDK_IDENTITY_READ_BUDGET_MS`，此时并发进程会把那份还是 0 字节的
文件当成坏的挪走并重建 —— 磁盘上仍只有一份，但卡住的赢家内存里留着另一个设备号。这比改动前
「每次都覆盖」已经窄得多（实测分裂概率从约 8% 降到 0，见 #2），但不是 0。要压更小可调大预算，
彻底闭合（把写入也纳入独占）另开票处理。多进程冷启动的一致性仍要靠「同一次抓包 + 同一份
identity」这套流程保证。

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

- **设备指纹不必"抓"**：默认由服务自己生成一份 16 位设备号并落盘复用；对照实验显示上游不要求
  它与账号登录设备一致。「静态抓包凭证回放」那条路是否要求设备号与那次抓包同源，本票没有重测。
- **Cookie 过期不会被 `/probe` 抓到**：本次在**一首**有授权的曲目上，不发 Cookie 也拿到整曲
  （样本只有这一首，别把它当通用结论，未测组合见调查报告第七节），所以「整曲」不代表 Cookie
  仍然有效。Cookie 是不是活的，要用你自己的播放器能不能登录态功能来判断，
  不要拿 `/probe` 当登录态探针。
- **日志**：stdout 是 JSON 行，只含请求形状与签名长度；可直接接文件/日志系统。
- **安全**：服务等于你账号的取流能力，不要公网暴露、不要分享 token。
