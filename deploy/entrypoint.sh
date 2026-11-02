#!/usr/bin/env bash
# 容器入口：首次启动初始化 Wine prefix（否则镜像里要背 1.6GB 的 prefix），
# 然后启动签名服务。prefix 挂在 /wine 卷上，所以只有第一次慢。
set -euo pipefail

cd /app

if [ ! -f "${WINEPREFIX}/system.reg" ]; then
    echo "[deploy] 首次启动：初始化 Wine prefix（约 20-40 秒）"
    wineboot -u >/dev/null 2>&1 || true
fi

# 后台作业在非交互 shell 里会按 POSIX 的规定继承 SIGINT=SIG_IGN，kill -INT 可能直接被忽略。
# 开 job control 让 wine 拿到默认的 SIGINT 处置与自己的进程组，转发才真的落到 Wine 的 handler。
set -m

# 为什么不再 exec：docker stop 发给 PID 1 的是 SIGTERM，而 Wine 的 signal_init 只给
# INT/QUIT 等装 handler，SIGTERM 没有对应处理 —— 进程可能当场退出（143），也可能挂到
# 宽限期被 SIGKILL。两种结果都让编排器从「连接被拒」开始看这次停止。
#
# 但**转成 SIGINT 也不够**：Wine 11 + Windows Node 20 的真机实测里，入口收到 SIGTERM、
# kill -INT 发出去了，Node 侧却没有 event=shutdown，/readyz 也没改口，容器最后被 SIGKILL。
# 所以容器形态的权威触发源是 state 目录下的 closing.flag（Node 侧轮询，见 src/serve.mjs）；
# SIGINT 只作为「别的 Wine 版本能走信号快路」的补充。
#
# trap 先于 spawn 安装：否则「子进程已起、trap 还没装」的窗口里来一个 SIGTERM 就会把
# 入口脚本直接带走，wine 变成孤儿。信号若抢在 child 就绪之前到达，先记下来；那一刻
# 还没有任何在飞请求可收，直接结束入口。
# set -m 只保证「入口脚本自己以默认 SIGINT 启动」（Docker 的 PID 1）时有效；被父 shell
# 以 & 拉起并继承 SIG_IGN 的场景不恢复，别把它当成无条件事实。
state_dir="${LIBMSSDK_STATE_DIR:-/app/data}"
close_file="${state_dir}/closing.flag"
# 上一次运行留下的标志不能把这次启动直接收掉（Node 侧 watcher 启动时也会清一次）
rm -f "$close_file" 2>/dev/null || true

child=''
stop_requested=0
forward_stop() {
    stop_requested=$((stop_requested + 1))
    [ -n "$child" ] || return 0
    if [ "$stop_requested" -gt 1 ]; then
        # 第二次信号是逃生口：不再等收尾，直接结束（客户端会看到连接重置）
        echo "[deploy] 第二次停止信号：跳过收尾，立即退出" >&2
        kill -9 "$child" 2>/dev/null || true
        exit 1
    fi
    mkdir -p "$state_dir" 2>/dev/null || true
    if : >"$close_file" 2>/dev/null; then
        echo "[deploy] 收到停止信号：写 ${close_file} 触发收尾" >&2
    else
        echo "[deploy] 收到停止信号：state 目录不可写，只能退回 SIGINT" >&2
    fi
    kill -INT "$child" 2>/dev/null || true
}
trap forward_stop TERM INT

wine /opt/node-win/node.exe src/index.mjs "${1:-serve}" &
child=$!
if [ "$stop_requested" -gt 0 ]; then
    echo "[deploy] 停止信号早于服务就绪：没有在飞请求可收，直接结束" >&2
    kill -9 "$child" 2>/dev/null || true
    exit 0
fi

# wait 会被信号打断：trap 跑完后再等一次，直到子进程真的退出。
# 每次都用 wait 的返回值覆盖 status，正常退出（0）才不会被上一轮的中断码污染。
status=0
while :; do
    wait "$child" && status=0 || status=$?
    kill -0 "$child" 2>/dev/null || break
done
exit "$status"
