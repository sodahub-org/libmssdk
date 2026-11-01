#!/usr/bin/env bash
# 容器入口：同一个 WINEPREFIX、同一份 identity.json、同一份 bdms.node，起 N 个 serve 进程。
# 与 deploy/entrypoint.sh 的差别：多进程、日志落文件、不做身份前置就没有前置、
# 去掉 set -e 与 exec（一个 serve 起不来要把证据留下，而不是让容器整体退出）。
#
# 进程清单由 run.sh 经 VERIFY_SERVE_PORTS 传入（空格分隔的容器内端口）。
set -uo pipefail

cd /app
mkdir -p /logs

PORTS=${VERIFY_SERVE_PORTS:-8899 8900}
export LIBMSSDK_BIND=0.0.0.0
export LIBMSSDK_CLIENT_DIR="${LIBMSSDK_CLIENT_DIR:-/app/client}"
export LIBMSSDK_STATE_DIR=/app/data
# 收尾观察要看到「可读的 503」而不是一开始就连接被拒：留一个排空窗口再停监听。
# 与 deploy/docker-compose.yml 同一个默认量级；验证脚本不依赖用户去改 compose。
export LIBMSSDK_DRAIN_DELAY_MS="${LIBMSSDK_DRAIN_DELAY_MS:-5000}"

if [ ! -f "${WINEPREFIX}/system.reg" ]; then
    echo "[verify] 首次启动：初始化 Wine prefix（约 20-40 秒）" >&2
    wineboot -u >/dev/null 2>&1 || true
fi

# 身份先落盘，再拉起进程：否则两个进程同时首次生成会分裂出两个 device_id。
# 那是 #2 的范围，不是本验证要测的东西；这里只做前置，不测竞态。
wine /opt/node-win/node.exe src/index.mjs config >/logs/identity-preflight.out 2>/logs/identity-preflight.err || true

SERVE_PIDS=()
for port in $PORTS; do
    LIBMSSDK_PORT="$port" wine /opt/node-win/node.exe src/index.mjs serve \
        >"/logs/serve-$port.out" 2>"/logs/serve-$port.err" &
    pid=$!
    SERVE_PIDS+=("$pid")
    echo "$pid" >"/logs/serve-$port.pid"
    echo "[verify] serve pid=$pid port=$port" >&2
done

# docker stop 发给 PID 1 的是 SIGTERM，而 Wine 只把 SIGINT 映射成 CTRL_C_EVENT。
# 与 deploy/entrypoint.sh 同一套转发：不转这一手，容器就是「进程直接消失」，
# 判据 7 观察到的形态会永远是连接被拒。
forward_stop() {
    echo "[verify] 收到停止信号：把 SIGINT 转给每个 serve（Wine 会映射为 CTRL_C_EVENT）" >&2
    for pid in "${SERVE_PIDS[@]}"; do
        kill -INT "$pid" 2>/dev/null || true
    done
}
trap forward_stop TERM INT

# wait 会被信号打断：trap 跑完后再等一次，直到子进程真的退出。
# 不写这个循环，PID 1 会在转发完 SIGINT 后立刻走到脚本结尾退出，Docker 随即把还在
# 排空窗口里的 serve 一起收掉 —— 判据 7 会因此永远看到 refused。
status=0
while :; do
    wait || status=$?
    alive=0
    for pid in "${SERVE_PIDS[@]}"; do
        kill -0 "$pid" 2>/dev/null && alive=1
    done
    (( alive == 0 )) && break
done
exit "$status"
