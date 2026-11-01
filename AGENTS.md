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
deploy/              Docker 一键部署（Wine + Windows 版 Node）与反向代理配置示例
src/config.mjs       环境变量、客户端目录、bdms 路径、身份配置合并
src/identity.mjs     身份文件：独占创建（唯一写入口）与只读加载
src/bdms.mjs         bdms.node 加载 / init / 签名；headers 展开和解析纯函数
src/contract.mjs     SignRequest 校验和 SignResponse 组装
src/log.mjs          日志与脱敏：凭据只留长度，本机路径一律换掉
src/auth.mjs         Bearer Token 比对（计时安全；只有分发器用它）与启动前的令牌检查
src/ratelimit.mjs    按 IP 的 GCRA 限流、IPv4 单地址与 IPv6 /64 分桶、地址脱敏、XFF 开关
src/route.mjs        路由解析：只从请求行取 pathname，Host 不参与，解析永不抛（两条路径共用）
src/errors.mjs       失败分类：状态码 / 原因码映射表与等待时长（纯函数；#9 起只有 /sign 走这张表）
src/dispatch.mjs     分发的纯判据：等待预算 / 队列上限 / worker 数推导 / 回环绑定判据 / 重生退避（时间从参数进来）
src/warmup.mjs       就绪判据自学习：连续同长 + 结构下限，代码里没有绝对长度数字
src/workerpool.mjs   worker 池（#5 唯一新增的接缝）：忙闲回收、逐台预热、退避重生、放弃
src/worker.mjs       worker 进程：不监听，只调原生模块算签名；身份只读
src/dispatcher.mjs   分发器：主进程独占监听、排队与预拼好的 503（#7 起是默认 /sign 路径）
src/serve.mjs        默认服务装配：/sign 走分发器，其余端点交给 endpoints，/stat 与限流状态在此装配
src/probe.mjs        track_v2 真机自检与整曲 / 试听判定；src 下唯一一处出网代码（fetchTrackV2）
src/endpoints.mjs    签名之外的 HTTP 面：/livez、/readyz（/healthz 别名）、/stat、旧诊断端点的回执、404
src/index.mjs        CLI：serve / bridge / selftest / probe / config
test/                使用 mock-bdms 的离线测试（含多进程争抢身份文件与真 fork worker 的用例）
tools/               手动脚本（打真机，不进 npm test，不随包发布）
verify/wine-multi/   手动验证：Docker + Wine 下多进程（不进 npm test，也不进 CI）
docs/CONTRACT.md     服务契约
docs/UPGRADING.md    升级说明：默认多进程、错误契约与端点收拢的行为变化
docs/DEPLOY-WINDOWS.md Windows 部署
docs/INVESTIGATION-DEVICE-ENTITLEMENT.md 设备身份与整曲权益的对照实验与结论
deploy/README.md     Docker 部署
```

## 硬性约定

1. **官方二进制不入库**：`bdms.node`、`metasecml.dll` 不提交、不发布、不再分发。
2. **签名覆盖 URL + 全部请求头**：`/sign` 收到的 headers 必须是调用方真实发送的一份。
3. **`x-ss-stub` 是 body 的 MD5 大写**，既是签名输入，也要随请求发送。
4. **设备号自洽**：`device_id` / `iid` / `fp` 与 `bdms.init({ deviceId })` 用同一份——
   这是本服务的内部约定（省掉每请求重新 `init`），**不是上游的强制要求**：实测上游不要求
   签名设备与账号登录设备一致，见 `docs/INVESTIGATION-DEVICE-ENTITLEMENT.md`。
5. **身份只有一个写入口**：写 `identity.json` 只能走 `src/identity.mjs` 的
   `prepareStoredIdentity()`（`open` 带 `wx` 独占创建，输的一方回读赢家的值），
   worker 侧用只读的 `readStoredIdentity()`。
   不要新增「先探测再写入」或「临时文件改名」这两类写法——它们都不保证只生成一次。
6. **空响应不代表接口故障**：签名不符时服务端可能返回 HTTP 200 + 0 bytes。
   是否成功必须用 `node src/index.mjs probe` 的 `fullTrack` 判定。
7. **不记录凭据**：日志只允许请求形状、签名长度、脱敏设备号与脱敏 IP。
   Cookie、`X-Helios`、`X-Medusa` 一律不落盘。
8. **零运行时依赖**：服务只用 Node 内置模块；测试也使用 mock。
9. **鉴权默认可用**：设置 `LIBMSSDK_TOKEN` 后，所有 POST 的**能力**路由（签名，以及任何会动数据或出网的入口）都需要 Bearer Token。
   绑定非回环地址时必须设置令牌，否则 `serve` 拒绝启动；只有绑定回环时才允许无令牌访问。
   不看凭据的只有这几类「回答」：健康探针、诊断端点 `/stat`、已删端点的回执与通用 404。探针与 `/stat`
   回的是运行状态（就绪与否、脱敏设备号、队列深度、限流桶计数 —— 地址一律脱敏），既不签名也不出网，
   也不带出任何凭据；回执与 404 回的是常量。能力本身一律要 Token。
10. **改签名或部署逻辑必须测试**：至少 `npm test`；有原生模块时再跑
    `node src/index.mjs selftest` 和真机 `probe` 命令。
11. **出网只此一处，HTTP 层不留入口**：`src/` 里向官方接口发请求的代码只有 `src/probe.mjs`
    （`fetchTrackV2` / `probeTrack`），入口只有命令行 `probe`，`verify/` 下的手动脚本也经它。
    （`tools/entitlement-matrix.mjs` 是 #10 的对照实验，故意自己构造请求，不与本服务共用。）
    不许变成 HTTP 端点的是「替调用方打上游」这类能力 —— 那等于任何人借这台机器去打官方接口，
    被封的是这台服务器，`/sign` 的正常用户跟着一起失败。只报服务自身状态的诊断端点
    （`GET /stat` 就是这一类：只报队列、worker 与限流计数，地址一律脱敏）不在此列：它不出网，也不替谁做事。
    `test/endpoints.test.mjs` 有结构守卫盯着这件事。

## 开源边界

源码使用 MIT。`vendor/soda-music/` 下的官方二进制专有、被 Git 忽略，不随仓库分发。
公开仓库不得包含用户 Cookie、Token、抓包签名值、真实设备指纹或本机路径。
