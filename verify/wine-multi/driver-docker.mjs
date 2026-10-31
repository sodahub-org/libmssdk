// 真环境控制面：观察全部经 docker exec 落在同一个容器里 —— 同一个 WINEPREFIX、
// 同一份 identity.json、同一份 bdms.node，两个 serve 进程。
//
// 容器生命周期由 run.sh 负责（构建镜像 → docker cp 二进制 → 起 → 收尾），
// 这里只做「读日志 / 探活 / 杀进程」。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fetchReady, probeReady, tailLines, waitForReady } from './endpoints.mjs'

const execFileAsync = promisify(execFile)

const LOG_DIR = '/logs'
const IDENTITY_FILE = '/app/data/identity.json'
const NODE_WIN = '/opt/node-win/node.exe'
/** 容器内进程计数（含 Wine 侧的 node.exe 与 wineserver）——环境记录与存活证据共用一份。 */
const COMM_COUNTS = 'for p in /proc/[0-9]*; do [ -r "$p/comm" ] && cat "$p/comm"; done 2>/dev/null | sort | uniq -c'

function toPort(value, label) {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} 不是合法端口：${value}`)
    return port
}

export function createDockerDriver({ container, containerPorts, hostPorts }) {
    const servePorts = containerPorts.map(port => toPort(port, '容器内 serve 端口'))
    const publicPorts = hostPorts.map(port => toPort(port, '宿主端口'))
    if (!/^[A-Za-z0-9_.-]+$/.test(container)) throw new Error(`容器名不合法：${container}`)

    const docker = async (args) => {
        const { stdout } = await execFileAsync('docker', args, { maxBuffer: 32 * 1024 * 1024 })
        return stdout
    }
    const inContainer = script => docker(['exec', container, 'bash', '-lc', script])
    const pidFile = index => `${LOG_DIR}/serve-${servePorts[index]}.pid`
    const errFile = index => `${LOG_DIR}/serve-${servePorts[index]}.err`
    const outFile = index => `${LOG_DIR}/serve-${servePorts[index]}.out`

    async function readPid(index) {
        const text = (await inContainer(`cat ${pidFile(index)} 2>/dev/null || true`)).trim()
        // 空 = 读不到（容器入口还没写到、或 /logs 卷不对）；0 会被误当成「进程已不在」
        return /^\d+$/.test(text) ? Number(text) : null
    }

    /** Wine 下的 Windows 版 Node 打不开管道型 stdio，所以它的输出必须先落文件再 cat。 */
    async function wineNode(argsText) {
        const marker = `/tmp/verify-winnode-${process.pid}.txt`
        const out = await inContainer(`wine ${NODE_WIN} ${argsText} > ${marker} 2>&1; cat ${marker}; rm -f ${marker}`)
        return out.trim()
    }

    return {
        kind: 'docker',
        hostPorts: publicPorts,
        upstreamOrigin: null,
        container,
        servePorts,

        async start() {
            const state = (await docker(['inspect', '--format', '{{.State.Running}} {{.Config.Image}}', container])).trim()
            if (!state.startsWith('true ')) throw new Error(`容器 ${container} 没在运行（当前：${state || '未知'}）。请先执行 verify/wine-multi/run.sh。`)
        },

        async processes() {
            const rows = []
            for (const [index, port] of publicPorts.entries()) rows.push({ port, servePort: servePorts[index], pid: await readPid(index) })
            return rows
        },

        async environment() {
            const wine = (await inContainer('wine --version 2>&1 || true')).trim()
            const nodeWin = await wineNode('--version')
            const dockerVersion = (await docker(['version', '--format', '{{.Server.Version}}'])).trim()
            const image = (await docker(['inspect', '--format', '{{.Config.Image}}', container])).trim()
            const counts = await inContainer(COMM_COUNTS)
            const wineserverCount = Number(/(\d+)\s+wineserver/.exec(counts)?.[1] ?? 0)
            return {
                kind: 'docker',
                wine,
                nodeWin,
                nodeHost: process.version,
                dockerServer: dockerVersion,
                image,
                container,
                wineserverCount,
                // 结构事实（run.sh 只挂了一个 /wine 卷给整个容器），不是测出来的结论；
                // 实测证据是上面的 wineserverCount
                winePrefix: '/wine',
                sharedIdentityFile: IDENTITY_FILE,
                summary: `镜像 ${image || '?'} / ${wine || 'wine ?'} / Windows Node ${nodeWin || '?'} / 宿主 Node ${process.version} / Docker ${dockerVersion} / wineserver ${wineserverCount} 个`,
            }
        },

        async processSnapshot() {
            const out = await inContainer(COMM_COUNTS)
            return out
                .split('\n')
                .map(line => line.trim())
                .filter(line => /node\.exe|wineserver/.test(line))
        },

        async readyz(index) {
            return fetchReady(publicPorts[index])
        },

        /** ready / http / refused / hung —— 判据 4 用它确认被杀方真的不再应答。 */
        async probePort(index) {
            return probeReady(publicPorts[index])
        },

        /**
         * 这个进程自己的身份视图：不点名设备号的 /sign，回包里的 device_id 就是它自己解析出来
         * 的那一份（原值只在内存里比对，不落盘）。
         *
         * URL 与 headers 里刻意不带 device_id / fp / did —— 带了就变成比对我们发过去的那个 id，
         * 身份真分裂了也照样「一致」，是循环论证。#9 删掉了明文返回整套身份的 /config，这条是它的替代。
         */
        async ownIdentity(index) {
            try {
                const response = await fetch(`http://127.0.0.1:${publicPorts[index]}/sign`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088',
                        method: 'POST',
                        headers: { 'user-agent': 'LunaPC/verify' },
                    }),
                    // 签一次名在 Wine 冷启动下要几十秒，别用探活那档的超时
                    signal: AbortSignal.timeout(60000),
                })
                if (!response.ok) return null
                const payload = await response.json()
                return payload?.device_id ? { deviceId: String(payload.device_id) } : null
            } catch {
                return null
            }
        },

        async waitForReady(timeoutMs) {
            return waitForReady(publicPorts, { timeoutMs, intervalMs: 2000, probeTimeoutMs: 4000 })
        },

        async readLogText(index) {
            return inContainer(`cat ${outFile(index)} ${errFile(index)} 2>/dev/null || true`)
        },

        async stderrOf(index) {
            const text = await inContainer(`cat ${errFile(index)} 2>/dev/null || true`)
            return { bytes: Buffer.byteLength(text), tail: tailLines(text) }
        },

        /** true = 进程在；false = 确认不在；null = 读不到 pid 文件，无法判断。 */
        async pidAlive(index) {
            const pid = await readPid(index)
            if (pid === null) return null
            const out = await inContainer(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)
            return out.trim() === 'alive'
        },

        /** 返回实际生效的杀法：'term' 或 'kill'（Wine 包装进程可能不转发 TERM）。 */
        async killProcess(index) {
            const pid = await readPid(index)
            if (pid === null) throw new Error(`读不到端口 ${servePorts[index]} 对应进程的 pid 文件（${pidFile(index)}）`)
            await inContainer(`kill ${pid} 2>/dev/null || true`)
            for (let waited = 0; waited < 6000; waited += 1000) {
                await new Promise(resolve => setTimeout(resolve, 1000))
                if ((await inContainer(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).trim() !== 'alive') return 'term'
            }
            // 把「杀不掉」与「杀掉之后另一个不服务」分开：先升级到 KILL 再交给判据 4 观察
            await inContainer(`kill -9 ${pid} 2>/dev/null || true`)
            return 'kill'
        },

        async readIdentityFile() {
            return inContainer(`cat ${IDENTITY_FILE} 2>/dev/null || true`)
        },

        teardown() {},
    }
}
