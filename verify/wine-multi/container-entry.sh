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
# 与 deploy/docker-compose.yml 同一个默认值；实际采样是 harness 的 250ms 轮询，
# 这条只保证进容器时与 compose 一致，不是在复用镜像的 HEALTHCHECK 节奏。
export LIBMSSDK_DRAIN_DELAY_MS="${LIBMSSDK_DRAIN_DELAY_MS:-8000}"

if [ ! -f "${WINEPREFIX}/system.reg" ]; then
    echo "[verify] 首次启动：初始化 Wine prefix（约 20-40 秒）" >&2
    wineboot -u >/dev/null 2>&1 || true
fi

# 身份先落盘，再拉起进程：否则两个进程同时首次生成会分裂出两个 device_id。
# 那是 #2 的范围，不是本验证要测的东西；这里只做前置，不测竞态。
wine /opt/node-win/node.exe src/index.mjs config >/logs/identity-preflight.out 2>/logs/identity-preflight.err || true

# 后台作业在非交互 shell 里会按 POSIX 的规定继承 SIGINT=SIG_IGN，kill -INT 可能直接被忽略。
# 与 deploy/entrypoint.sh 一样开 job control，让 wine 拿到默认处置。
set -m

# 真机证据（#23）：Wine 11 + Windows Node 20 下，入口转发的 SIGINT 到不了 Node（没有
# event=shutdown，最后被 SIGKILL）。容器形态的权威触发源是 state 目录下的 closing.flag；
# SIGINT 只作为别的 Wine 版本上能走信号快路的补充。两个 serve 共用 /app/data，
# 一个标志会让两边都收尾；标志内容是本轮随机 token，旧标志天然不匹配，触发后不删。
close_token=$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n' || true)
[ -n "$close_token" ] || close_token="run-$$-$(date +%s)"
export LIBMSSDK_CLOSE_TOKEN="$close_token"
rm -f /app/data/closing.flag 2>/dev/null || true

SERVE_PIDS=()
stop_requested=0
forward_stop() {
    stop_requested=$((stop_requested + 1))
    [ ${#SERVE_PIDS[@]} -gt 0 ] || return 0
    if [ "$stop_requested" -gt 1 ]; then
        echo "[verify] 第二次停止信号：跳过收尾，立即退出" >&2
        for pid in "${SERVE_PIDS[@]}"; do
            kill -9 "$pid" 2>/dev/null || true
        done
        exit 1
    fi
    echo "[verify] 收到停止信号：写 /app/data/closing.flag 触发收尾" >&2
    printf '%s' "$close_token" >/app/data/closing.flag 2>/dev/null || true
    for pid in "${SERVE_PIDS[@]}"; do
        kill -INT "$pid" 2>/dev/null || true
    done
}
trap forward_stop TERM INT

for port in $PORTS; do
    LIBMSSDK_PORT="$port" wine /opt/node-win/node.exe src/index.mjs serve \
        >"/logs/serve-$port.out" 2>"/logs/serve-$port.err" &
    pid=$!
    SERVE_PIDS+=("$pid")
    echo "$pid" >"/logs/serve-$port.pid"
    echo "[verify] serve pid=$pid port=$port" >&2
done

# 停止信号抢在 serve 就绪之前：没有在飞请求可收，直接结束。
if [ "$stop_requested" -gt 0 ]; then
    echo "[verify] 停止信号早于 serve 就绪：没有在飞请求可收，直接结束" >&2
    for pid in "${SERVE_PIDS[@]}"; do
        kill -9 "$pid" 2>/dev/null || true
    done
    exit 0
fi

# wait 会被信号打断：trap 跑完后再等一次，直到子进程真的退出。
# 不写这个循环，PID 1 会在转发完 SIGINT 后立刻走到脚本结尾退出，Docker 随即把还在
# 排空窗口里的 serve 一起收掉 —— 判据 7 会因此永远看到 refused。
status=0
while :; do
    wait && status=0 || status=$?
    alive=0
    for pid in "${SERVE_PIDS[@]}"; do
        kill -0 "$pid" 2>/dev/null && alive=1
    done
    (( alive == 0 )) && break
done
exit "$status"
