#!/usr/bin/env bash
# 一键部署：生成 token → 构建镜像 → 启动 → 等健康检查 → 打印用法
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE="docker compose"
if ! docker compose version >/dev/null 2>&1; then
    if command -v docker-compose >/dev/null 2>&1; then
        COMPOSE="docker-compose"
    else
        echo "错误：需要 docker compose（或 docker-compose）" >&2
        exit 1
    fi
fi

# 1) 首次运行生成 .env（随机 token + 监听地址）
if [ ! -f .env ]; then
    TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
    cat >.env <<EOF
# libmssdk 部署配置（run.sh 生成，勿提交）
LIBMSSDK_TOKEN=${TOKEN}
# 0.0.0.0 = 允许外部访问（务必配合防火墙/反向代理）；只想本机用就写 127.0.0.1
LIBMSSDK_BIND=${LIBMSSDK_BIND:-0.0.0.0}
LIBMSSDK_PORT=${LIBMSSDK_PORT:-8899}
# 指向你自己安装的汽水客户端版本目录（内含 resources/）
LIBMSSDK_CLIENT_DIR=
EOF
    chmod 600 .env
    echo "✓ 已生成 deploy/.env（含随机 token）"
else
    echo "• 复用已有 deploy/.env"
fi

# shellcheck disable=SC1091
set -a && . ./.env && set +a

# 1.2) 原生签名模块必须由用户提供
if [ -z "${LIBMSSDK_CLIENT_DIR:-}" ]; then
    echo "错误：请先在 deploy/.env 设置 LIBMSSDK_CLIENT_DIR。" >&2
    echo "      指向你本机安装的汽水音乐版本目录（内含 resources/）。" >&2
    echo "      该目录会以只读方式挂进容器，用于提供 bdms.node 和 metasecml.dll。" >&2
    exit 1
fi

# 1.5) 指定了绝对路径就先把目录建好（compose 不会自动建绑定挂载目录）
for dir in "${LIBMSSDK_DATA_PATH:-}" "${LIBMSSDK_WINE_PATH:-}"; do
    case "$dir" in
        /*) mkdir -p "$dir" && echo "• 数据目录 $dir" ;;
    esac
done

# 2) 构建 + 启动（已用 docker load 导入过镜像时，LIBMSSDK_SKIP_BUILD=1 跳过构建）
if [ "${LIBMSSDK_SKIP_BUILD:-0}" = "1" ]; then
    echo "• 使用已有镜像启动（跳过构建）"
    $COMPOSE up -d
else
    echo "• 构建镜像并启动（首次构建要装 Wine，约 3-5 分钟、镜像约 3GB）"
    $COMPOSE up -d --build
fi

# 3) 等健康检查
echo -n "• 等待服务就绪"
for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${LIBMSSDK_PORT}/healthz" >/dev/null 2>&1; then
        echo " ✓"
        break
    fi
    echo -n "."
    sleep 2
done

if ! curl -fsS "http://127.0.0.1:${LIBMSSDK_PORT}/healthz" >/dev/null 2>&1; then
    echo
    echo "✗ 服务未在 2 分钟内就绪，看日志： $COMPOSE logs -f" >&2
    exit 1
fi

# 4) 自检 + 打印用法
echo
echo "── 状态 ─────────────────────────────────────────────"
curl -fsS "http://127.0.0.1:${LIBMSSDK_PORT}/healthz"; echo

echo "── 签名自检（POST /sign，真跑一次）──────────────────"
SIGN=$(curl -fsS -X POST "http://127.0.0.1:${LIBMSSDK_PORT}/sign" \
    -H "Authorization: Bearer ${LIBMSSDK_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"url":"https://api.qishui.com/luna/pc/track_v2?aid=386088&device_id=1&version_name=3.8.0","method":"POST","headers":{"user-agent":"LunaPC/selftest","content-type":"application/json"}}')
echo "$SIGN" | head -c 200; echo
case "$SIGN" in
    *'"ok":true'*) echo "✓ 签名正常（X-Helios / X-Medusa 已生成）" ;;
    *)
        echo "✗ 签名失败，看日志： $COMPOSE logs --tail 50" >&2
        exit 1
        ;;
esac
echo
echo "── 客户端接入 ───────────────────────────────────────"
echo "export QISHUI_SIGNER_URL=http://<本机或公网 IP>:${LIBMSSDK_PORT}/sign"
echo "export QISHUI_SIGNER_TOKEN=${LIBMSSDK_TOKEN}   # libresoda 会读这两个变量并自动带 Authorization"
echo
echo "── 常用命令 ─────────────────────────────────────────"
echo "$COMPOSE logs -f          # 日志（JSON 行，不含 cookie）"
echo "$COMPOSE restart          # 重启"
echo "$COMPOSE down             # 停止（设备身份保存在 volume 里）"
