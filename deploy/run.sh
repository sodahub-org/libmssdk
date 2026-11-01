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
# 宿主上把明文 8899 发布到哪张网卡：0.0.0.0 = 允许外部直连（配合防火墙 + token）；
# 只想本机用、或前面挂了反向代理，就写 127.0.0.1（代理在容器网络里照样能访问服务）。
# 下面 SIGNER_HOSTNAME 或 LIBMSSDK_TRUST_PROXY 一旦填上，这里不收成回环 run.sh 就拒绝启动。
LIBMSSDK_BIND=${LIBMSSDK_BIND:-0.0.0.0}
LIBMSSDK_PORT=${LIBMSSDK_PORT:-8899}
# 前面挂同机反向代理时改成 1，并把上面的 LIBMSSDK_BIND 改成 127.0.0.1
# LIBMSSDK_TRUST_PROXY=0
# 故意同时保留对外的明文入口（只在内网防火墙后面时才成立）：改成 1，run.sh 放行但会留一句提醒
# LIBMSSDK_ALLOW_PUBLIC_HTTP=0
# 指向你自己安装的汽水客户端版本目录（内含 resources/）
LIBMSSDK_CLIENT_DIR=
# 只在上反向代理那一层时需要（docker compose -f docker-compose.yml -f docker-compose.proxy.yml）
# 填上它就等于声明前面挂了同机反代，run.sh 会要求上面的 LIBMSSDK_BIND 是 127.0.0.1
# SIGNER_HOSTNAME=signer.example.com
EOF
    chmod 600 .env
    echo "✓ 已生成 deploy/.env（含随机 token）"
else
    echo "• 复用已有 deploy/.env"
fi

# shellcheck disable=SC1091
# 三条分开写：`. ./.env` 里只要有一行 bash 跑失败（见 1.1），用 && 串起来就会跳过 `set +a`，
# allexport 一直开着 —— 后面 bind_value、is_loopback，连签名自检拿到的 SIGN（X-Helios/X-Medusa）
# 都会被导进 compose 与 curl 的子进程环境。读不动的那一行交给 1.1 去判，这里只保证一定收尾。
set -a
. ./.env || :
set +a

# 1.1) .env 里有 bash 读不进去的行，就先停下
#      `LIBMSSDK_BIND = 0.0.0.0`（等号两侧带空格，加 export 前缀同理）在 bash 里不是赋值，而是
#      「找一个叫 LIBMSSDK_BIND 的命令」：变量根本没设上，后面的检查看见的是空值、按缺省的回环放行，
#      而 compose 用它自己那套 .env 解析，两边读到的不一定是同一份配置。脚本读不动这份文件时不能替它担保。
#      `LIBMSSDK_BIND: 0.0.0.0` 是同一类的第二种写法：compose 认 YAML 式的冒号（compose-go 的 dotenv
#      解析把 '=' 和 ':' 都当分隔符），bash 只把 `LIBMSSDK_BIND:` 当成一个命令名 —— 所以分隔符两种都认。
#      判据不只看变量现在的值：同一个键写了两行、后一行是坏形状时，bash 留着前一行的好值继续跑，
#      而 compose 那份解析取哪一行不是本脚本能验的事 —— 两边可能对不上，就一律不替它担保。
#      值为空（KEY=、KEY=""、KEY: ）与没写这一行同义，两边都按缺省走，不算读不进去；注释行不算。
#      只管脚本自己会读的那几个变量。
# 两条判据，命中一条就停：
#   1) 形状读不进去：分隔符是冒号，或等号两侧有空白 —— 这种行 bash 永远当命令跑。
#   2) 形状看着正常、变量却是空的：值里有空格又没加引号（`LIBMSSDK_CLIENT_DIR=C:\…\Soda Music\3.7.0`
#      就是这么写的，仓库的 .env.example 第 10 行原本也是这一型），bash 会把这一行拆成
#      「赋值 + 跑一个命令」，整行作废，而 compose 照旧读出那个值 —— 此时报错不能再说「你没填」。
env_declares_value() {
    # $1 = 变量名；文件里这一行有没有一个真实的值（引号包住的算，空值与只剩注释的不算）。
    local key=$1
    grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*[=:][[:space:]]*([\"'][^\"']|[^[:space:]\"'#])" .env
}

env_unreadable_shape() {
    # $1 = 变量名；判据 1 的三种坏分隔符形状：冒号、等号前有空白、等号后有空白。
    # 同样要求后面跟得到一个真实的值（`KEY:`、`KEY: ""`、`KEY: # 注释` 都不算）。
    local key=$1
    grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}([[:space:]]*:[[:space:]]*|[[:space:]]+=|[[:space:]]*=[[:space:]]+)[[:space:]]*([\"'][^\"']|[^[:space:]\"'#])" .env
}

for unread_key in LIBMSSDK_TOKEN LIBMSSDK_BIND LIBMSSDK_PORT LIBMSSDK_TRUST_PROXY SIGNER_HOSTNAME \
    LIBMSSDK_CLIENT_DIR LIBMSSDK_DATA_PATH LIBMSSDK_WINE_PATH LIBMSSDK_SKIP_BUILD LIBMSSDK_ALLOW_PUBLIC_HTTP; do
    if env_unreadable_shape "$unread_key" || { [ -z "${!unread_key:-}" ] && env_declares_value "$unread_key"; }; then
        echo "错误：deploy/.env 里的 ${unread_key} 这一行 bash 读不进去 —— 等号两侧带空格、写成 YAML 式的" >&2
        echo "      ${unread_key}: 值，或者值里有空格却没加引号（如 C:\Program Files\…），都会这样。" >&2
        echo "      compose 有自己的 .env 解析，脚本没法确认它看到的就是真正生效的那份，这条检查也就没法替你把关。" >&2
        echo "      请把这一行写成 ${unread_key}=值（等号两侧不留空白）；值里带空格的用双引号包住：${unread_key}=\"…\"。" >&2
        exit 1
    fi
done

# 1.2) 原生签名模块必须由用户提供
if [ -z "${LIBMSSDK_CLIENT_DIR:-}" ]; then
    echo "错误：请先在 deploy/.env 设置 LIBMSSDK_CLIENT_DIR。" >&2
    echo "      指向你本机安装的汽水音乐版本目录（内含 resources/）。" >&2
    echo "      该目录会以只读方式挂进容器，用于提供 bdms.node 和 metasecml.dll。" >&2
    exit 1
fi

# 1.3) 要挂反向代理，宿主的明文口就必须收进回环
#      这条以前只在 README 与 compose 注释里，靠人读；跳过那一步的人照样在把 token 与 cookie
#      走明文发出去。判断只能落在部署脚本侧：容器里的进程永远看到 0.0.0.0（docker-compose.yml 写死）。
# 「要挂同机反代」有两个来源：叠层读的 SIGNER_HOSTNAME，以及服务是否已经在认 X-Forwarded-For。
# 取值集合必须跟上 src/config.mjs 的 envFlag（1/true/yes/on，不分大小写，用例逐条对着它比）：
# compose 把这个变量原样透传进容器，只认 "1" 的话 LIBMSSDK_TRUST_PROXY=true 就溜过去了；
# 不去空白的话 `" on "` 又会溜过去 —— 两种都是「服务真在对外口上认 XFF，脚本一声不吭」。
# 归一化比 envFlag 更狠（去的是所有空白，不只是两端）：`t rue` 这类写法服务当没打开、脚本当打开了，
# 差出来的方向是脚本多拦一道，不会少拦。
proxy_signal=''
if [ -n "${SIGNER_HOSTNAME:-}" ]; then
    proxy_signal="SIGNER_HOSTNAME=${SIGNER_HOSTNAME}"
fi
trust_proxy=${LIBMSSDK_TRUST_PROXY:-0}
trust_proxy=${trust_proxy//[[:space:]]/}
case "${trust_proxy,,}" in
    1 | true | yes | on)
        proxy_signal="${proxy_signal:+$proxy_signal、}LIBMSSDK_TRUST_PROXY=${trust_proxy}"
        ;;
esac

# 回环判据与 src/dispatch.mjs 的 isLoopbackBind 同口径（用例把两边摆在一起逐条对过）：先去空白再小写，
# 127/8 只认点分四段、每段 0-255 —— 127.evil.com 这种「看着像回环的主机名」不算，DNS 能把它指到公网，
# 而 compose 会把宿主端口绑到它解析出来的地址上。去空白比那边的 trim 更狠（内嵌的也去），但方向是安全的：
# `127.0. 0.1` 在这里算回环，而 compose 拿原值去绑根本绑不上，明文口开不出来。
# 缺省值取 127.0.0.1：与 docker-compose.yml 的 ${LIBMSSDK_BIND:-127.0.0.1} 一致，没写这一行时 compose
# 本来就只绑回环，那不是违规，不能误拦。
bind_value=${LIBMSSDK_BIND:-127.0.0.1}
bind_value=${bind_value//[[:space:]]/}
bind_value=${bind_value,,}
octet='([1-9]?[0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])'
is_loopback=0
case "$bind_value" in
    localhost | ::1 | '[::1]' | 0:0:0:0:0:0:0:1) is_loopback=1 ;;
    127.*)
        if [[ $bind_value =~ ^127\.${octet}\.${octet}\.${octet}$ ]]; then
            is_loopback=1
        fi
        ;;
esac

if [ -n "$proxy_signal" ] && [ "$is_loopback" = 0 ]; then
    # 逃生舱只认 "1"（与本脚本的 LIBMSSDK_SKIP_BUILD 同风格），不像 TRUST_PROXY 那样跟着服务扩取值：
    # 它放开的是风险本身，写错就落回拒绝，这个方向保守一次是好事。空白与 CR 还是去掉 —— 用户已经写了
    # "1" 却因为这行末尾多一个空格被拦，报错又叫他去做他做过的事，那是把人往绕过检查上推。
    allow_public_http=${LIBMSSDK_ALLOW_PUBLIC_HTTP:-0}
    allow_public_http=${allow_public_http//[[:space:]]/}
    if [ "$allow_public_http" = "1" ]; then
        echo "注意：LIBMSSDK_ALLOW_PUBLIC_HTTP=1 已放行 —— 宿主明文口 ${LIBMSSDK_PORT:-8899} 仍对外可达（LIBMSSDK_BIND=${LIBMSSDK_BIND}）。" >&2
        echo "      这只在「确实要同时保留对外的明文入口，且它在内网防火墙后面」时成立：token 等价于签名能力，它和 cookie 走的都是明文。" >&2
    else
        echo "错误：${proxy_signal} 说明前面挂了反向代理，LIBMSSDK_BIND 就必须收进回环（例如 127.0.0.1 或 ::1），现在是 ${LIBMSSDK_BIND}。" >&2
        echo "      否则任何人都能绕过 443 直连 http://<host>:${LIBMSSDK_PORT:-8899}/sign，Bearer token 与请求里的 cookie 全走明文；" >&2
        echo "      开了 LIBMSSDK_TRUST_PROXY 时这条直连还能自带伪造的 X-Forwarded-For 自选分桶键，限流等于没开。" >&2
        echo "      改法：在 deploy/.env 写 LIBMSSDK_BIND=127.0.0.1。它管的是宿主上把端口发布到哪张网卡，" >&2
        echo "      容器内进程固定监听 0.0.0.0，代理经服务名 libmssdk:8899 访问，不受这一行影响。" >&2
        echo "      确实要同时留着对外的明文入口（只有内网防火墙后面这一种情形），设 LIBMSSDK_ALLOW_PUBLIC_HTTP=1；见 deploy/README.md 第 2 步。" >&2
        exit 1
    fi
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
# /readyz 要等至少一台 worker 预热完成（/livez 才是恒 200 的那个）；Docker 的起始宽限期是 180 秒，这里给到约 200 秒
for _ in $(seq 1 100); do
    if curl -fsS "http://127.0.0.1:${LIBMSSDK_PORT}/readyz" >/dev/null 2>&1; then
        echo " ✓"
        break
    fi
    echo -n "."
    sleep 2
done

if ! curl -fsS "http://127.0.0.1:${LIBMSSDK_PORT}/readyz" >/dev/null 2>&1; then
    echo
    echo "✗ 服务未在约 3 分钟内就绪，看日志： $COMPOSE logs -f" >&2
    exit 1
fi

# 4) 自检 + 打印用法
echo
echo "── 状态 ─────────────────────────────────────────────"
curl -fsS "http://127.0.0.1:${LIBMSSDK_PORT}/readyz"; echo

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
