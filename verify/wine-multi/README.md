# verify/wine-multi —— Docker + Wine 多进程验证

一条命令回答一个问题：**同一个容器、同一个 `WINEPREFIX`、同一份 `identity.json`、同一份
`bdms.node`，两个 `serve` 进程能不能同时工作**（[sodahub-org/libmssdk#6](https://github.com/sodahub-org/libmssdk/issues/6)）。

它是**手动执行**的验证脚本，不进 `npm test`、不进 CI —— 因为它要用户自备的官方二进制和真实凭据。

## 一条命令

```bash
# 真环境：Linux / WSL + Docker，自备原生模块；要打上游判据就给 track_id 与 cookie
bash verify/wine-multi/run.sh --track <track_id> --env-file /tmp/libmssdk-verify.env

# 没有 Docker、没有凭据：先把判定流水线彩排一遍
bash verify/wine-multi/run.sh --mode mock
```

退出码：`0` 通过 / `1` 失败 / `2` 部分完成（跑起来了，但有判据没执行，例如没给 `--track`）/
`3` 前置条件或用法不满足（缺 docker、缺原生模块、选项写错——验证根本没开始）。
结果 JSON 落在 `results/`（被 `.gitignore` 挡住）。

## 测什么

| 判据 | 外部可见事实 | 挂了会归成哪种形态 |
| --- | --- | --- |
| 1 两个进程同时签名 | 两边 `/sign` 都回 200，且 `X-Helios` 与 `X-Medusa` 都非空 | 进程起不来 |
| 2 各自签的头各打一次上游 | 上游 `HTTP 200` 且回包能解析成曲目 | 签名能出但上游不接受 |
| 3 连打 N 轮 | 每轮两边各签一次（有 cookie 时各打一次上游） | 上面两种 |
| 4 杀掉一个，另一个继续服务 | 被杀方 pid 不再存在**且**它的端口不再应答；存活方仍出签名 | 一个进程把共享 prefix 拖垮 |
| 5 两个进程共用同一份身份 | 每个进程自己的身份视图（**不点名设备号**的 `/sign` 回包里的 `device_id`，原值只在内存比对、不落盘）**彼此**逐字节相同；共享身份文件与 `/readyz` 脱敏值是两道印证 | 单列发现（device_id 分裂属 #2） |
| 6 输出与日志不泄露 | 扫 serve 自己的日志，找 cookie / 签名值 / 完整设备号；结果文件在写盘前拦 | 脱敏失败 |

判据 4 只判「服务断没断」。存活方签出的头被上游打回，会照样记进形态二与计数，但**不**把判据 4
翻成 FAIL——上游接不接受是判据 2/3 的领域，账号权益问题不该看起来像多进程坏了。

判据 5 用的是每个进程**自己的**身份视图：`POST /sign` 时 URL、headers 与请求体里都不给设备号，
签名器就会用它自己解析出来的那一份，回包里的 `device_id` 就是那个进程的身份原值（只在内存比对，
登记为敏感）。点名了设备号的 `/sign` 不能拿来比：那回的是我们发过去的那个 id，身份真分裂了也
照样"一致"，是循环论证。

这条证据比 #9 之前的窄：原先 `GET /config` 会把整套 `device_id` / `iid` / `fp` 原值带回来，
而那个端点明文返回完整设备号、又没有客户端在调，已经删掉了。所以现在逐进程比的只有 `device_id`，
`iid` / `fp` 只在「与共享身份文件一致」这一侧比——两个进程读的是同一份文件，文件对得上就够。
`comparedFields` 如实写着这次到底比了哪几个字段。

两个进程彼此一致、却和共享身份文件对不上时记 **PARTIAL** 而不是 PASS：判据主体成立，
但「来自这份文件」的印证断了，原因（显式覆盖 `LIBMSSDK_DEVICE_ID` / 状态目录挂错）脚本分不出来，
需要人工核对。
进程不足两个、或 `/sign` 读不到它自己的设备号时同样只到 PARTIAL（比不了就明说比不了），
两道印证都拿不到才记 BLOCKED——这几种都不等于身份分裂。

三种失败形态靠**可观察特征**区分，不靠猜：

* **进程起不来（含起来过又退出）** —— 该进程的 pid 确认不在了；或 pid 还在但端口拒绝连接（没在监听），通常伴随 `stderr` 有内容。
* **签名能出但上游不接受** —— `/sign` 回 200 且两个头都在，上游是 `HTTP 200 + 0 字节`（官方对签名不符的真实形态）或非 200。
* **一个进程把共享 prefix 拖垮** —— 两种可观察形态之一：同一时间窗内两个以上端口一起失败；或杀掉一个之后另一个不再应答，且它的 pid 还在、`stderr` 安静。
  后者依赖镜像里 `WINEDEBUG=-all`（`deploy/Dockerfile` 设定）——调试模式一开，Wine 会往 stderr 狂写，「stderr 安静」这个条件就不成立了。

上游请求本身失败（网络、超时）不冒充上面三种，记成「说不清」并附原始错误；进程在答话、只是这一单
`/sign` 失败（比如回 500），同样记「说不清」而不是「起不来」——它是算错了，不是没起来。签名请求与
上游请求分开计数，所以「签名失败 N 次」只算 `/sign` 这一步。判据 6 在没跑过带 cookie 的判据时只记
`PARTIAL`：没有 cookie 参与签名，「日志里没有 cookie」这条就没被真正检验过。

判据 2 的门禁是「上游接不接受这份签名」，**不是** `fullTrack`：后者取决于账号权益与设备身份
（#10 在查这件事），把它当门禁会把权益问题误报成多进程问题。`fullTrack` 与曲目时长仍如实记在结果里。
同样地，判据 2 PASS 也不背书凭据是否有效：实测用一个明显是假的 cookie 打真实 `track_v2`，
上游照样回 `200 / 17 KB`——这个端点验的是签名的头，不是登录态。

判据各自只管自己那件事，但**整体结论不粉饰**：只要记过一条失败（哪怕是判据 4 有意不计入自身状态的那种），
结论就是「失败」/ exit `1`。

## 停止期间的观察（#23）

真环境跑完判据 1–6 之后，harness 会执行一次 `docker stop --time 30`，同时每 250ms 问一次**停止前仍活着**
的 serve 进程的 `/readyz`，把观察到的形态序列记进结果的 `observations.stopObservation`。判据 4 已经杀掉
一个进程，它的端口注定是连接被拒，所以不参与这一条：把死掉的端口也算进去，证据会永远翻成 `mixed`。

- 期望 `saw-503`：entrypoint 把 `SIGTERM` 转成 `SIGINT` 交给 Wine，Node 先改口 `/readyz`、排空窗口里
  仍在监听，窗口结束才停监听、收在飞请求；之后才变成连接被拒。
- `refused-only` 说明信号没送到 Node（或排空窗口为 0）：容器形态退化成「进程直接消失」。
- `mixed` 表示两个进程观察不一致，按结果里的 `sequences` 人工核对。
- `ERROR` 表示观察阶段自己出错（例如容器已经不在、`docker exec` 失败）；只记这一条，不影响 1–6 的结论。

这一条只是**记录**，不参与通过/失败的门禁：Wine 的 Ctrl+C 转发在 9.x 有过回归（见 #23 的调研），
把版本差异折成一个 FAIL 会掩盖真正要看的东西。彩排模式没有容器可停，这一条记 `SKIPPED`。
注意 `--keep` 保留的容器这时是**已停止**状态，要重新跑就 `docker start` 或先 `docker rm -f`。

## 前置条件

1. **Docker**（Linux 或 WSL2）与一个 x86_64 主机；ARM 上要 QEMU 模拟，很慢。
2. **自备官方二进制**：`bdms.node` + `metasecml.dll`，默认从 `vendor/soda-music/` 取，
   也可 `--client-dir` 指向你自己的汽水版本目录。仓库不含也不分发它们。
3. **要打真实上游才需要 cookie**：`--env-file` 指一个 600 权限的文件，里面一行
   `LIBMSSDK_COOKIE=<原始 cookie 串>`（带 `;` 和 `=` 原样写就行，脚本按行读取，**不做 `source` 求值**）。
   它只存在于宿主侧 harness 进程的环境与请求体里：**不进镜像、不进容器环境变量、不出现在
   `docker inspect`、不进结果文件**。注意它会随签名请求体进入容器内的 `/sign`——签名覆盖
   「URL + 全部请求头」，cookie 就是其中之一，这是契约要求的，不是泄露。
4. **一个 `track_id`**：用本机实际播放过的曲子最能说明问题。
5. 首次构建镜像需要能访问 `dl.winehq.org` 与 `nodejs.org`（约 3–5 分钟）。
6. **宿主侧 Node ≥ 20.11**（harness 用到 `import.meta.dirname`）。容器里跑的是镜像钉住的
   Windows Node 20.18.0，与这条无关；`package.json` 的 `>=18` 说的是服务本身，验证脚本不在其中。

镜像与卷：默认用 `deploy/Dockerfile` 构建 `libmssdk:local`，身份与 Wine prefix 各用一个命名卷。
`--skip-build --image <已有 tag>` 复用镜像，`--data-volume` / `--wine-volume` 复用已有的身份与 prefix。
跑完只删容器，**三个卷都保留**（身份卷、prefix 卷、日志卷）——换身份卷等于换一个设备号，
删 prefix 卷等于下次冷启动重来；要清盘自己 `docker volume rm`。

## 已知的环境坑（跟产品无关，但会把复现带偏）

1. **不要把 `bdms.node` 放在 `/mnt/*` 这类 drvfs 绑定挂载里加载。** 实测：Wine 在 `DllMain`
   里访问违例（读模块基址 + 偏移），该模块自己的异常处理器无限重入直到打穿栈，并**一直握着
   Wine 的 loader 锁**，于是同 prefix 下所有进程一起卡住（90 秒不返回、CPU 近似空转）。
   所以 `run.sh` 用 `docker cp` 把两个二进制放进容器自己的文件系统。换 Wine 版本不解决——
   是挂载路径的问题，不是 Wine 版本或多实例的问题。
2. **`docker exec`（不加 `-t`）不能把 `wine node.exe` 直接接在管道上**，会 `open EBADF`：
   Wine 下的 Node 打不开管道型 stdio。加 `-t` 能跑，但 TTY 会在 80 列插换行，多行 JSON 被切断。
   脚本的做法是容器内 bash 把输出重定向到文件再 `cat` 出来（见 `driver-docker.mjs` 的 `wineNode`）。
3. **`--skip-build` 测的是镜像里的 `src`**。改过 `src/` 就要去掉 `--skip-build` 重新构建，
   否则测的是旧代码。
4. **身份先落盘，再拉起进程。** `container-entry.sh` 先跑一次 `config` 把 `identity.json` 写好。
   否则两个进程同时首次生成会分裂出两个 `device_id`（实测约 8%）——那是 #2 的范围，
   本验证不测这个竞态，只在判据 5 里检查两个进程读到的是不是同一份。
5. **判据 4 杀的是 `wine` 包装进程**，所以「被杀方真的走了」要两条同时成立：pid 不再存在，且它的端口
   拒绝连接（`observations.victimPortState`）。端口挂住或仍在应答都不算走干净；容器内 `node.exe` 与
   `wineserver` 的计数作为辅助证据一起写进结果（`observations.processesAfterKill`）。
6. 到 `dl.winehq.org` 的 IPv6 不通的机器上构建会卡在 `curl`；用 `--skip-build --image <tag>`
   复用已有镜像，或按自己的网络另备一份 Dockerfile。

## 彩排模式（`--mode mock`）证明什么、不证明什么

本机起两个**真 `serve` 进程**（跑 `src/index.mjs serve`），签名模块用仓库自带的
`test/fixtures/mock-bdms.mjs`，上游是 `127.0.0.1` 上的假 `track_v2`——缺签名头或 `x-ss-stub`
与 body 的 MD5 不符时，按官方形态回 `200 + 0 字节`。

* **证明**：判据流水线本身、三种失败形态的判定、输出脱敏（cookie 是随机哨兵串，
  结果文件与服务日志里都必须找不到它）。
* **不证明**：Wine 的行为、真实 `bdms.node`、真实上游。

注入失败形态：`--scenario ok | process-start | upstream-reject | prefix-contention`。
最后一种用 `SIGSTOP` 复现「pid 还在、不应答、stderr 安静」的卡死形态，**需要 Linux/WSL**；
在 Windows 上它会在起步时就拒绝并退 `3`（说明本场景在此平台不可用），不会跑到一半崩掉把结果
与退出码一起吞掉。

彩排给两个进程各挑一个本机空闲端口（先绑再放，存在极小的竞争窗口）；真撞上端口占用时，
结论会以「进程起不来」的形式出现，重跑一次即可。

## 敏感边界

* cookie 不进镜像、不进容器环境变量、不出现在 `docker inspect` 里；它只在宿主侧 harness 进程的环境里。
  但它**必须**出现在发给 `/sign` 的请求体里——签名覆盖「URL + 全部请求头」，cookie 是其中之一，
  这是契约要求，不是泄露；服务侧不把它落盘，判据 6 就是扫 serve 自己的日志来证明这一点。
* 签名值只记长度；设备号只以 `123***456` 形式出现；`results/` 与 `logs/` 不入库。
* 结果文件里若混进敏感值，脚本拒绝写盘并以 `1` 退出。
* 泄漏发生在 **serve 自己的日志** 里时（判据 6 FAIL），报告只存类别名（`leakedKinds`），原始值
  不进报告，所以文件照常写盘、退出码 `1`——两种路径都不会把敏感值落进仓库里的东西。

## 文件

| 文件 | 作用 |
| --- | --- |
| `run.sh` | 一条命令：镜像 / 容器 / 二进制进容器 / 跑 harness / 收尾 |
| `container-entry.sh` | 容器入口：同一个 prefix 起 N 个 `serve`，日志落文件 |
| `harness.mjs` | 判据流水线、失败形态判定、结论与脱敏 |
| `endpoints.mjs` | 两个控制面共用的 `/readyz` 探活与就绪等待 |
| `driver-docker.mjs` | 真环境控制面：`docker exec` 读日志、探活、杀进程、记版本 |
| `driver-mock.mjs` | 彩排控制面：本机两个 serve + 假上游 + 故障注入 |

## 这些数字只是参照

一台 8 逻辑核机器上的量级观察：热态单次签名几十到一百多毫秒，Wine prefix 首启 20–40 秒，
`init` 之后一小段窗口内可能出短签名、之后长度稳定。**绝对值换机器要重测**，脚本只记录
观察到的长度，不拿它们当门禁——写死长度会让这台机器永远不就绪。

「两个进程确实各自独立、又共用一个 wineserver」这件事的证据都在结果里：`processes[]` 的两个
不同 pid、`tally.rounds.processes` 与 `observations.processesAfterKill` 里的 `node.exe` 计数、
以及 `environment.wineserverCount`。脚本不去断言它们该等于几，只把看到的写下来。
