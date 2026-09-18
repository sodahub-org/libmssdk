# 一键部署镜像：在 Linux 上跑 Windows 版签名模块（bdms.node + metasecml.dll）。
#
# 为什么要 Wine：bdms.node 是 Windows PE，只能由 Windows 版 Node/Electron 加载。
# 实测 Wine 11 + Windows Node 20 可以正常加载并出签名，服务端也接受
#（/probe 返回 fullTrack: true）。注意 Node 24 在 Wine 下会 CSPRNG 断言崩溃，钉 20。

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_WIN_VERSION=20.18.0 \
    NODE_WIN_SHA256=f5cea43414cc33024bbe5867f208d1c9c915d6a38e92abeee07ed9e563662297 \
    WINEPREFIX=/wine \
    WINEDEBUG=-all \
    WINEDLLOVERRIDES=mscoree,mshtml= \
    LIBMSSDK_BIND=0.0.0.0 \
    LIBMSSDK_PORT=8899 \
    LIBMSSDK_STATE_DIR=/app/data

# Wine：用 WineHQ 官方源（Debian 自带的 wine64 包不带 wine 前端）
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg unzip \
 && mkdir -pm755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key \
 && curl -fsSL -o /etc/apt/sources.list.d/winehq-bookworm.sources https://dl.winehq.org/wine-builds/debian/dists/bookworm/winehq-bookworm.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends winehq-stable \
 && rm -rf /opt/wine-stable/share/wine/mono /opt/wine-stable/share/wine/gecko \
           /opt/wine-stable/share/doc /opt/wine-stable/share/man \
 && apt-get purge -y --auto-remove gnupg \
 && rm -rf /var/lib/apt/lists/*

# Windows 版 Node：bdms.node 必须由 Windows 版 Node 加载（它链接 node.exe / libnode.dll）
RUN curl -fsSL -o /tmp/node.zip "https://nodejs.org/dist/v${NODE_WIN_VERSION}/node-v${NODE_WIN_VERSION}-win-x64.zip" \
 && echo "${NODE_WIN_SHA256}  /tmp/node.zip" | sha256sum -c - \
 && mkdir -p /tmp/node-extract \
 && unzip -q /tmp/node.zip -d /tmp/node-extract \
 && mv /tmp/node-extract/node-v*-win-x64 /opt/node-win \
 && rm -rf /tmp/node.zip /tmp/node-extract \
 && test -f /opt/node-win/node.exe

WORKDIR /app
COPY package.json /app/package.json
COPY src /app/src
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# /app/data = 设备身份；/wine = Wine prefix（首次启动生成约 1.5GB，之后复用）
VOLUME ["/app/data", "/wine"]
EXPOSE 8899

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8899/healthz || exit 1

# 必须带 TTY 运行（compose 里 tty: true / docker run -t）：
# Wine 下的 Node 打不开管道类型的 stdout/stderr，会报 open EBADF
ENTRYPOINT ["/app/entrypoint.sh"]
