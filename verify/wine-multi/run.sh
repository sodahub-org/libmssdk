#!/usr/bin/env bash
# 一条命令跑完「Docker + Wine 下多进程能不能同时工作」的验证（sodahub-org/libmssdk#6）。
#
#   bash verify/wine-multi/run.sh --track <track_id>        # 真环境：Docker + Wine + 自备模块
#   bash verify/wine-multi/run.sh --mode mock               # 本机彩排：不需要 Docker/Wine/凭据
#
# 真环境需要（全部由用户提供，仓库里没有也不入库）：
#   1. bdms.node + metasecml.dll（--client-dir，默认 vendor/soda-music）
#   2. 要跑上游判据时给 cookie：--env-file <文件>（600；按行取值、不做 shell 求值，
#      不进容器环境变量、不进 docker 配置、不进结果；它会随签名请求体进容器，这是契约要求的）
# 结论走 harness.mjs；这个脚本只管镜像、容器、二进制进容器、收尾。
set -euo pipefail

MODE=docker
IMAGE=libmssdk:local
DOCKERFILE=deploy/Dockerfile
CONTAINER=libmssdk-verify-wine
VOL_DATA=libmssdk-verify-data
VOL_WINE=libmssdk-verify-wine
VOL_LOGS=libmssdk-verify-logs
SERVE_PORTS='8899 8900'
HOST_PORTS='18899,18900'
CLIENT_DIR=''
ENVFILE=''
TRACK=''
ROUNDS=''
READY_TIMEOUT=''
SCENARIO=ok
KEEP=0
SKIP_BUILD=0
NODE_BIN=${NODE_BIN:-node}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

usage() {
    cat <<'EOF'
用法：bash verify/wine-multi/run.sh [选项]

  --mode docker|mock     docker = 真环境（默认）；mock = 本机彩排（不需要 Docker/Wine/凭据）
  --track <track_id>     要打真实上游判据时必填；不给则跳过上游判据，结论记为「部分完成」
  --rounds <N>           连打轮数（docker 默认 10，mock 默认 3）
  --ready-timeout-ms <N> 等两个进程就绪的预算（docker 默认 180000，Wine prefix 首启用得上）
  --client-dir <目录>    自备 bdms.node / metasecml.dll 所在目录（默认 vendor/soda-music）
  --env-file <文件>      给 LIBMSSDK_COOKIE 用的环境文件（600，按行取值不做 shell 求值；
                         不进容器环境变量、不进 docker 配置、不进结果文件）
  --image <tag>          使用/产出的镜像 tag（默认 libmssdk:local）
  --dockerfile <path>    构建用的 Dockerfile（默认 deploy/Dockerfile）
  --skip-build           镜像已存在时不重建（到 dl.winehq.org 的 IPv6 不通时用这个 + 自建镜像）
  --data-volume <名>     设备身份卷（默认 libmssdk-verify-data；想复用已有身份就指到它）
  --wine-volume <名>     Wine prefix 卷（默认 libmssdk-verify-wine；首启要 20-40 秒与约 1.5GB）
  --serve-ports "a b"    容器内 serve 端口清单（默认 "8899 8900"）
  --host-ports a,b       宿主映射端口（默认 18899,18900，只绑 127.0.0.1）
  --scenario <name>      仅 mock：ok | process-start | upstream-reject | prefix-contention（注入失败形态）
  --keep                 跑完保留容器（调试用；两个卷里的 Wine prefix 与身份始终保留）
  --node <path>          宿主侧 node 可执行文件（默认 node）
EOF
}

die() {
    # 3 = 前置条件或用法不满足，验证根本没开始跑（2 留给「跑了一部分但有判据没执行」）
    echo "[verify] $*" >&2
    exit 3
}

# 带值选项先整体校验一遍：`--rounds` 光挂着会让下面 `$2` 在 set -u 下炸成退出码 1，
# 而文档里 1 是「失败」、3 才是「用法不满足」
for ((index = 1; index <= $#; index += 1)); do
    case "${!index}" in
        --mode | --track | --rounds | --ready-timeout-ms | --client-dir | --env-file | --image | --dockerfile | --serve-ports | --host-ports | --scenario | --node | --data-volume | --wine-volume)
            next=$((index + 1))
            [[ $next -le $# && "${!next}" != --* ]] || die "${!index} 需要带值"
            ;;
    esac
done

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode) MODE=$2; shift 2 ;;
        --track) TRACK=$2; shift 2 ;;
        --rounds) ROUNDS=$2; shift 2 ;;
        --ready-timeout-ms) READY_TIMEOUT=$2; shift 2 ;;
        --client-dir) CLIENT_DIR=$2; shift 2 ;;
        --env-file) ENVFILE=$2; shift 2 ;;
        --image) IMAGE=$2; shift 2 ;;
        --dockerfile) DOCKERFILE=$2; shift 2 ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        --data-volume) VOL_DATA=$2; shift 2 ;;
        --wine-volume) VOL_WINE=$2; shift 2 ;;
        --serve-ports) SERVE_PORTS=$2; shift 2 ;;
        --host-ports) HOST_PORTS=$2; shift 2 ;;
        --scenario) SCENARIO=$2; shift 2 ;;
        --keep) KEEP=1; shift ;;
        --node) NODE_BIN=$2; shift 2 ;;
        -h | --help) usage; exit 0 ;;
        *) echo "[verify] 未知选项：$1" >&2; usage; exit 3 ;;
    esac
done

if [[ "$MODE" == mock ]]; then
    command -v "$NODE_BIN" >/dev/null 2>&1 || die "没找到宿主侧 node（$NODE_BIN）：彩排也要用本机 node 跑"
    [[ -z "$ENVFILE" ]] || echo '[verify] 提醒：--mode mock 一律用随机哨兵串当 cookie，--env-file 与宿主环境里的 LIBMSSDK_COOKIE 在这里都不生效（真实凭据不该进彩排）。' >&2
    echo '[verify] 彩排模式：本机 Node + 仓库自带 mock 签名模块 + 假上游，不碰 Docker/Wine/真实凭据。'
    MOCK_ARGS=(--mode mock --scenario "$SCENARIO")
    [[ -n "$ROUNDS" ]] && MOCK_ARGS+=(--rounds "$ROUNDS")
    [[ -n "$READY_TIMEOUT" ]] && MOCK_ARGS+=(--ready-timeout-ms "$READY_TIMEOUT")
    exec "$NODE_BIN" "$SCRIPT_DIR/harness.mjs" "${MOCK_ARGS[@]}"
fi

if [[ "$MODE" != docker ]]; then
    die "未知 --mode：$MODE（可用：docker / mock）"
fi

command -v docker >/dev/null 2>&1 || die '没找到 docker：真环境验证要在有 Docker 的 Linux/WSL 上跑（本机彩排用 --mode mock）'
command -v "$NODE_BIN" >/dev/null 2>&1 || die "没找到宿主侧 node（$NODE_BIN）：harness 要用本机 Linux/Windows Node 跑"

if [[ -n "$ENVFILE" ]]; then
    [[ -f "$ENVFILE" ]] || die "环境文件不存在：$ENVFILE"
    PERMS=$(stat -c '%a' "$ENVFILE" 2>/dev/null || echo unknown)
    [[ "$PERMS" == 600 || "$PERMS" == 400 ]] || echo "[verify] 提醒：$ENVFILE 权限是 $PERMS，建议 chmod 600" >&2
    # 按行取值，绝不用 source：真实 cookie 里就带 `;` 和 `=`，交给 shell 求值等于
    # 把 cookie 的一部分当命令执行
    read_env_value() {
        local want=$1 line name value
        while IFS= read -r line || [[ -n "$line" ]]; do
            line=${line%$'\r'}    # 环境文件在 Windows 上编辑过就是 CRLF，带个 \r 会把 cookie 弄坏
            [[ "$line" == *=* ]] || continue    # 没有等号的行跳过：否则键名自己会变成值被当凭据发出去
            name=${line%%=*}
            value=${line#*=}
            [[ "$name" == "$want" ]] || continue
            # 只有整体被一对同类引号包住、且内部没有裸引号时才剥掉，免得把 "a=1"; b="c" 剪坏
            if [[ ${#value} -ge 2 && ${value:0:1} == '"' && ${value: -1} == '"' && ${value:1:${#value}-2} != *'"'* ]]; then
                value=${value:1:${#value}-2}
            elif [[ ${#value} -ge 2 && ${value:0:1} == "'" && ${value: -1} == "'" && ${value:1:${#value}-2} != *"'"* ]]; then
                value=${value:1:${#value}-2}
            fi
            printf '%s' "$value"
            return 0
        done < "$ENVFILE"
        return 1
    }
    if COOKIE_FROM_FILE=$(read_env_value LIBMSSDK_COOKIE); then
        export LIBMSSDK_COOKIE="$COOKIE_FROM_FILE"
        echo "[verify] 从 $ENVFILE 读到 LIBMSSDK_COOKIE（${#LIBMSSDK_COOKIE} 字符；不进容器环境变量、不进 docker 配置、不进结果文件）"
    else
        die "$ENVFILE 里没有 LIBMSSDK_COOKIE=… 这一行"
    fi
fi

if [[ ! -f "$REPO_ROOT/$DOCKERFILE" ]]; then
    die "找不到 Dockerfile：$REPO_ROOT/$DOCKERFILE"
fi

if [[ "$SKIP_BUILD" != 1 ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "[verify] 构建镜像 $IMAGE（首次要装 Wine，约 3-5 分钟）…"
    docker build --network=host -f "$REPO_ROOT/$DOCKERFILE" -t "$IMAGE" "$REPO_ROOT"
fi
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "镜像 $IMAGE 不可用：去掉 --skip-build 先构建"

CLIENT_DIR=${CLIENT_DIR:-$REPO_ROOT/vendor/soda-music}
[[ -d "$CLIENT_DIR" ]] || die "客户端目录不存在：$CLIENT_DIR（用 --client-dir 指向你自己的汽水版本目录）"
BDMS=$(find "$CLIENT_DIR" -maxdepth 4 -name 'bdms.node' -print -quit 2>/dev/null || true)
DLL=$(find "$CLIENT_DIR" -maxdepth 4 -name 'metasecml.dll' -print -quit 2>/dev/null || true)
[[ -n "$BDMS" && -n "$DLL" ]] || die "$CLIENT_DIR 里找不到 bdms.node / metasecml.dll：官方二进制不入库，需要你从自己安装的客户端里提供"

SERVE_PORT_ARRAY=($SERVE_PORTS)
IFS=',' read -r -a HOST_PORT_ARRAY <<<"$HOST_PORTS"
[[ ${#SERVE_PORT_ARRAY[@]} == ${#HOST_PORT_ARRAY[@]} ]] || die '--serve-ports 与 --host-ports 的个数要一致'
[[ ${#SERVE_PORT_ARRAY[@]} -ge 2 ]] || die '至少要两个 serve 进程才叫多进程验证'

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker volume create "$VOL_DATA" >/dev/null
docker volume create "$VOL_WINE" >/dev/null
docker volume create "$VOL_LOGS" >/dev/null

PORT_ARGS=()
for index in "${!SERVE_PORT_ARRAY[@]}"; do
    PORT_ARGS+=(-p "127.0.0.1:${HOST_PORT_ARRAY[$index]}:${SERVE_PORT_ARRAY[$index]}")
done

echo "[verify] 创建容器 $CONTAINER（${#SERVE_PORT_ARRAY[@]} 个 serve，映射 127.0.0.1:${HOST_PORTS}）…"
docker create --name "$CONTAINER" \
    -e LIBMSSDK_STATE_DIR=/app/data \
    -e VERIFY_SERVE_PORTS="$SERVE_PORTS" \
    "${PORT_ARGS[@]}" \
    -v "$VOL_DATA:/app/data" \
    -v "$VOL_WINE:/wine" \
    -v "$VOL_LOGS:/logs" \
    -v "$SCRIPT_DIR:/verify:ro" \
    --entrypoint bash \
    "$IMAGE" /verify/container-entry.sh >/dev/null

# 二进制必须拷进容器自己的文件系统：从 /mnt/* 这类 drvfs 绑定挂载里加载 bdms.node，
# Wine 会在 DllMain 里访问违例并把 loader 锁一直握着，同 prefix 所有进程一起卡死。
# 走一个临时目录再整目录 cp：docker cp 单个文件不会替目标目录建父目录，而 metasecml.dll
# 必须和 bdms.node 同目录（Wine 按加载模块所在目录找它的依赖）。
STAGE=$(mktemp -d)
cleanup() {
    rm -rf "$STAGE"
    if [[ "$KEEP" == 1 ]]; then
        echo "[verify] --keep：容器已被判据 7（docker stop 观察）停止；要再用就 docker start $CONTAINER（两个卷里的 Wine prefix 与身份始终保留）"
        return
    fi
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cp "$BDMS" "$STAGE/bdms.node"
cp "$DLL" "$STAGE/metasecml.dll"
docker cp "$STAGE/." "$CONTAINER:/app/client"

docker start "$CONTAINER" >/dev/null
echo '[verify] 容器已启动（Wine prefix 首启 20-40 秒，之后复用卷很快）…'

HARNESS_ARGS=(--mode docker --container "$CONTAINER" --container-ports "$(IFS=,; echo "${SERVE_PORT_ARRAY[*]}")" --host-ports "$HOST_PORTS")
[[ -n "$TRACK" ]] && HARNESS_ARGS+=(--track "$TRACK")
[[ -n "$ROUNDS" ]] && HARNESS_ARGS+=(--rounds "$ROUNDS")
[[ -n "$READY_TIMEOUT" ]] && HARNESS_ARGS+=(--ready-timeout-ms "$READY_TIMEOUT")
if [[ -z "$TRACK" ]]; then
    echo '[verify] 没给 --track：不打真实上游，判据 2 与判据 3 的上游部分不会执行，结论最多是「部分完成」。' >&2
fi

"$NODE_BIN" "$SCRIPT_DIR/harness.mjs" "${HARNESS_ARGS[@]}"
