#!/usr/bin/env bash
# 容器入口：首次启动初始化 Wine prefix（否则镜像里要背 1.6GB 的 prefix），
# 然后启动签名服务。prefix 挂在 /wine 卷上，所以只有第一次慢。
set -euo pipefail

cd /app

if [ ! -f "${WINEPREFIX}/system.reg" ]; then
    echo "[deploy] 首次启动：初始化 Wine prefix（约 20-40 秒）"
    wineboot -u >/dev/null 2>&1 || true
fi

# 为什么不再 exec：docker stop 发给 PID 1 的是 SIGTERM，而 Wine 只把 SIGINT 映射成
# Windows 的 CTRL_C_EVENT，SIGTERM 不产生任何 console event。直接 exec 等于让 SIGTERM
# 落在 Wine 手里被忽略，容器随后被 SIGKILL —— 那就是「进程直接消失」。
# 这里转一手：收到 SIGTERM/SIGINT 后把 SIGINT 交给 wine 的 Unix 进程，Wine 变成 Ctrl+C，
# Node 侧的 SIGINT 处理器照常先改口 /readyz、按需留排空窗口、再停监听收在飞请求。
wine /opt/node-win/node.exe src/index.mjs "${1:-serve}" &
child=$!

forward_stop() {
    echo "[deploy] 收到停止信号：把 SIGINT 转给 wine（Wine 会映射为 CTRL_C_EVENT）" >&2
    kill -INT "$child" 2>/dev/null || true
}
trap forward_stop TERM INT

# wait 会被信号打断：trap 跑完后再等一次，直到子进程真的退出。
# 每次都用 wait 的返回值覆盖 status，正常退出（0）才不会被上一轮的中断码污染。
status=0
while :; do
    wait "$child" && status=0 || status=$?
    kill -0 "$child" 2>/dev/null || break
done
exit "$status"
