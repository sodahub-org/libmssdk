// 真环境控制面：观察全部经 docker exec 落在同一个容器里 —— 同一个 WINEPREFIX、
// 同一份 identity.json、同一份 bdms.node，两个 serve 进程。
//
// 容器生命周期由 run.sh 负责（构建镜像 → docker cp 二进制 → 起 → 收尾），
// 这里只做「读日志 / 探活 / 杀进程」。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fetchOwnIdentity, fetchReady, probeReady, probeStatus, tailLines, waitForReady } from './endpoints.mjs'

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

        /** 这个进程自己的身份视图（原值只在内存里比对）。Wine 冷启动下签一次要几十秒，别用探活那档超时。 */
        async ownIdentity(index) {
            return fetchOwnIdentity(publicPorts[index], 60000)
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

        /**
         * #23 的补充验证：`docker stop` 期间 /readyz 到底回了什么。
         *
         * 修好之后应当先看到可读的 503（entrypoint 把 SIGTERM 转成 SIGINT、Node 改口、排空窗口
         * 内仍在监听），最后才变成连接被拒；没修好时从头就是 refused。这里只记录真的观察到过的
         * 形态序列，不靠 sleep 猜，也不把 Wine 版本差异藏起来。
         */
        async observeStop({
            graceSeconds = 30,
            intervalMs = 250,
            probeTimeoutMs = 800,
            indexes = publicPorts.map((_, index) => index),
        } = {}) {
            // 判据 4 已经杀过一个进程，它的端口注定是 refused。只观察停之前还活着的那些，
            // 否则「每个端口都出现 503」永远不成立，证据会稳定地翻成 mixed。
            const watched = indexes.filter(index => Number.isInteger(index) && index >= 0 && index < publicPorts.length)
            const sequences = watched.map(() => [])
            const note = (slot, kind) => {
                const list = sequences[slot]
                if (list.at(-1) !== kind) list.push(kind)
            }
            let stopError = null
            const stopping = docker(['stop', '--time', String(graceSeconds), container]).catch(error => {
                stopError = String(error?.message || error)
            })
            // inspect 偶发失败不能当成「容器已经停了」：否则会提前结束采样、伪造出一个 refused。
            // 连续几次读不到才算停（容器被移除时 inspect 会真的报错）。
            let inspectErrors = 0
            const deadline = Date.now() + (graceSeconds + 15) * 1000
            for (;;) {
                let running = true
                try {
                    running = (await docker(['inspect', '--format', '{{.State.Running}}', container])).trim() === 'true'
                    inspectErrors = 0
                } catch {
                    inspectErrors += 1
                }
                for (const [slot, index] of watched.entries()) {
                    const result = await probeStatus(publicPorts[index], probeTimeoutMs)
                    note(slot, result.kind === 'http' ? `http-${result.status}` : result.kind)
                }
                if (!running || inspectErrors >= 3 || Date.now() > deadline) break
                await new Promise(resolve => setTimeout(resolve, intervalMs))
            }
            await stopping
            return {
                container,
                stopError,
                sequences: watched.map((index, slot) => ({ port: publicPorts[index], sequence: sequences[slot] })),
            }
        },

        teardown() {},
    }
}
