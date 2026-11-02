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
# 宽限期被 SIGKILL。两种结果都让编排器从「连接被拒」开始看这次停止。转成 SIGINT 才走得
# 到 Node 的收尾序列。
# trap 先于 spawn 安装：否则「子进程已起、trap 还没装」的窗口里来一个 SIGTERM 就会把
# 入口脚本直接带走，wine 变成孤儿。信号若抢在 child 就绪之前到达，先记下来；那一刻
# 还没有任何在飞请求可收，直接结束入口，不赌「补发一次 SIGINT」的时序（Wine 的处理器
# 还没装好时，这一下会被忽略，然后容器要等满宽限期才被 SIGKILL）。
# set -m 只保证「入口脚本自己以默认 SIGINT 启动」（Docker 的 PID 1）时有效；被父 shell
# 以 & 拉起并继承 SIG_IGN 的场景不恢复，别把它当成无条件事实。
child=''
stop_requested=0
forward_stop() {
    stop_requested=1
    [ -n "$child" ] || return 0
    # 每次信号都转发：第一次进优雅收尾，第二次起是逃生口（Node 侧 closing 已置位，直接 exit）。
    echo "[deploy] 收到停止信号：把 SIGINT 转给 wine（Wine 会映射为 CTRL_C_EVENT）" >&2
    kill -INT "$child" 2>/dev/null || true
}
trap forward_stop TERM INT

wine /opt/node-win/node.exe src/index.mjs "${1:-serve}" &
child=$!
if [ "$stop_requested" = 1 ]; then
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
