#!/usr/bin/env bash
# 容器入口：首次启动初始化 Wine prefix（否则镜像里要背 1.6GB 的 prefix），
# 然后启动签名服务。prefix 挂在 /wine 卷上，所以只有第一次慢。
set -euo pipefail

cd /app

if [ ! -f "${WINEPREFIX}/system.reg" ]; then
    echo "[deploy] 首次启动：初始化 Wine prefix（约 20-40 秒）"
    wineboot -u >/dev/null 2>&1 || true
fi

exec wine /opt/node-win/node.exe src/index.mjs "${1:-serve}"
