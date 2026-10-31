// 彩排控制面：不碰 Docker/Wine，用仓库自带的 mock 签名模块 + 一个假上游，
// 在本机起两个真 serve 进程，把同一套判据流水线跑一遍。
//
// 它证明的是「这套验证脚本本身会判、会脱敏」，不证明 Wine 行为；
// 三种失败形态靠这里的注入复现（进程起不来 / 上游不接受 / 存活方被拖垮）。

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fetchReady, probeReady, tailLines, waitForReady } from './endpoints.mjs'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..')
const MOCK_BDMS = path.join(PROJECT_ROOT, 'test', 'fixtures', 'mock-bdms.mjs')

export const SCENARIOS = ['ok', 'process-start', 'upstream-reject', 'prefix-contention']

/** 上游对签名不符的真实形态就是 HTTP 200 + 0 字节，假上游照这个形态回。 */
function mockTrackPayload() {
    return JSON.stringify({
        track: { id: '1000000000000000001', name: '彩排曲目', duration: 278500 },
        track_player: {
            video_model: JSON.stringify({
                video_duration: 278,
                video_list: [{ gear_des_key: 'mock', video_meta: { quality: 'mock', codec_type: 'MP4', bitrate: 128000, size: 4000000 } }],
            }),
        },
    })
}

async function allocatePorts(count) {
    const probes = []
    for (let index = 0; index < count; index += 1) {
        const probe = net.createServer()
        await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
        probes.push(probe)
    }
    const ports = probes.map(probe => probe.address().port)
    await Promise.all(probes.map(probe => new Promise(resolve => probe.close(resolve))))
    return ports
}

export function createMockDriver({ scenario = 'ok', cookie = '' }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-verify-'))
    const stateDir = path.join(tmpDir, 'data')
    const logDir = path.join(tmpDir, 'logs')
    // 「存活方挂住不应答」只能靠 SIGSTOP 造；Windows 上 Node 直接拒这个信号
    // （ERR_UNKNOWN_SIGNAL 在 convertToValidSignal 就抛，不经过 libuv），所以提前拒绝，
    // 而不是跑一半崩掉把结果文件和退出码一起吞了
    const canStopProcess = process.platform !== 'win32'
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(logDir, { recursive: true })

    const children = []
    let ports = []
    let origin = ''
    let upstreamServer = null
    let stoppedSiblings = false

    const logPath = (kind, port) => path.join(logDir, `serve-${port}.${kind}`)
    const isDead = entry => entry.spawnError !== undefined || entry.child.exitCode !== null || entry.child.signalCode !== null

    /** declaredPort 是判据用来探活/取日志的端口；bindPort 是它真正去绑的端口。 */
    function spawnServe(declaredPort, bindPort) {
        const out = fs.openSync(logPath('out', declaredPort), 'a')
        const err = fs.openSync(logPath('err', declaredPort), 'a')
        const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.mjs'), 'serve'], {
            cwd: PROJECT_ROOT,
            env: {
                ...process.env,
                // 子进程也只拿得到哨兵串，宿主环境里的真实凭据不该进彩排
                LIBMSSDK_COOKIE: cookie,
                LIBMSSDK_BIND: '127.0.0.1',
                LIBMSSDK_PORT: String(bindPort),
                LIBMSSDK_STATE_DIR: stateDir,
                LIBMSSDK_BDMS_MODULE: MOCK_BDMS,
                // 彩排只绑 127.0.0.1，不设 token：本验证要测的是多进程加载，不是鉴权路径
                LIBMSSDK_TOKEN: '',
            },
            stdio: ['ignore', out, err],
        })
        fs.closeSync(out)
        fs.closeSync(err)
        if (child.pid) fs.writeFileSync(logPath('pid', declaredPort), `${child.pid}\n`)
        const entry = { port: declaredPort, pid: child.pid, child, spawnError: undefined }
        // spawn 失败（可执行文件不对等）只发 'error' 事件：不接住就是未处理异常，
        // 接住了也要让它算「已死」，否则探活会一直说进程还在
        child.on('error', error => {
            entry.spawnError = String(error?.message || error)
        })
        children.push(entry)
    }

    function startUpstream() {
        const server = http.createServer((request, response) => {
            const chunks = []
            request.on('data', chunk => chunks.push(chunk))
            request.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8')
                const stubMatches = String(request.headers['x-ss-stub'] || '') === crypto.createHash('md5').update(body).digest('hex').toUpperCase()
                const hasSignature = Boolean(request.headers['x-helios']) && Boolean(request.headers['x-medusa'])
                const reject = scenario === 'upstream-reject' || !hasSignature || !stubMatches
                response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                response.end(reject ? '' : mockTrackPayload())
            })
        })
        return new Promise(resolve =>
            server.listen(0, '127.0.0.1', () => {
                upstreamServer = server
                resolve(`http://127.0.0.1:${server.address().port}`)
            }),
        )
    }

    const entryFor = index => children.find(item => item.port === ports[index])

    return {
        kind: 'mock',
        get hostPorts() {
            return ports
        },
        get upstreamOrigin() {
            return origin
        },

        async start() {
            if (scenario === 'prefix-contention' && !canStopProcess) {
                throw new Error('prefix-contention 这个场景要靠 SIGSTOP 造「进程挂着不应答」，Windows 上没有这个手段——请在 Linux/WSL 里跑彩排')
            }
            // 与容器入口同一个前置动作：先把身份落盘，再拉起进程。
            const preflight = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src', 'index.mjs'), 'config'], {
                cwd: PROJECT_ROOT,
                env: { ...process.env, LIBMSSDK_STATE_DIR: stateDir, LIBMSSDK_BDMS_MODULE: MOCK_BDMS, LIBMSSDK_COOKIE: cookie },
                stdio: 'ignore',
            })
            await new Promise(resolve => {
                preflight.on('exit', resolve)
                preflight.on('error', resolve)
            })

            origin = await startUpstream()
            const [first, second] = await allocatePorts(2)
            spawnServe(first, first)
            // 注入「进程起不来」：第二个进程去绑第一个已经占用的端口，EADDRINUSE 直接退出。
            spawnServe(second, scenario === 'process-start' ? first : second)
            ports = [first, second]
            await new Promise(resolve => setTimeout(resolve, 1500))
        },

        async processes() {
            return children.map(entry => ({ port: entry.port, pid: entry.pid }))
        },

        async environment() {
            return {
                kind: 'mock',
                scenario,
                wine: 'n/a（彩排不经 Wine，也不加载真实 bdms.node）',
                nodeWin: 'n/a（彩排跑的是本机 Linux/Windows Node，不是镜像里的 Windows Node 20.18.0）',
                nodeHost: process.version,
                signatureModule: 'test/fixtures/mock-bdms.mjs',
                upstream: origin,
                summary: `彩排模式（scenario=${scenario}）：本机 Node ${process.version} + mock 签名模块 + 假上游 ${origin}；只验证判据流水线与脱敏，不证明 Wine 行为`,
            }
        },

        async processSnapshot() {
            return children.map(entry => ({
                port: entry.port,
                pid: entry.pid,
                dead: isDead(entry),
                exitCode: entry.child.exitCode,
                signal: entry.child.signalCode,
            }))
        },

        async readyz(index) {
            return fetchReady(ports[index])
        },

        /** ready / http / refused / hung */
        async probePort(index) {
            return probeReady(ports[index])
        },

        /**
         * 每个进程自己的身份视图：不点名设备号的 /sign，回包里的 device_id 就是它自己解析出来的
         * 那一份（原值只在内存比对，不落盘）。URL / headers 里都不带设备号，否则就成了比对
         * 我们自己发过去的值。#9 删掉了 /config，这条是它的替代。
         */
        async ownIdentity(index) {
            try {
                const response = await fetch(`http://127.0.0.1:${ports[index]}/sign`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088',
                        method: 'POST',
                        headers: { 'user-agent': 'LunaPC/verify' },
                    }),
                    signal: AbortSignal.timeout(15000),
                })
                if (!response.ok) return null
                const payload = await response.json()
                return payload?.device_id ? { deviceId: String(payload.device_id) } : null
            } catch {
                return null
            }
        },

        async waitForReady(timeoutMs) {
            return waitForReady(ports, { timeoutMs, intervalMs: 500, probeTimeoutMs: 3000 })
        },

        async readLogText(index) {
            const entry = entryFor(index)
            if (!entry) return ''
            let text = ''
            for (const kind of ['out', 'err']) {
                try {
                    text += fs.readFileSync(logPath(kind, entry.port), 'utf8')
                } catch {
                    /* 还没写 */
                }
            }
            return text
        },

        async stderrOf(index) {
            const entry = entryFor(index)
            if (!entry) return { bytes: 0, tail: [] }
            let text = ''
            try {
                text = fs.readFileSync(logPath('err', entry.port), 'utf8')
            } catch {
                /* 还没写 */
            }
            return { bytes: Buffer.byteLength(text), tail: tailLines(text) }
        },
        /** true = 进程在；false = 确认不在；null = 没有这个进程的记录，无法判断。 */
        async pidAlive(index) {
            const entry = entryFor(index)
            if (!entry) return null
            if (isDead(entry)) return false
            try {
                process.kill(entry.pid, 0)
                return true
            } catch {
                return false
            }
        },

        async killProcess(index) {
            const entry = entryFor(index)
            if (!entry || isDead(entry)) return 'already-dead'
            let mode = 'term'
            try {
                entry.child.kill('SIGTERM')
            } catch {
                mode = 'kill'
                try {
                    entry.child.kill('SIGKILL')
                } catch {
                    /* 已经没了 */
                }
            }
            // 注入「一个进程倒下把共享 prefix 拖垮」：Wine 下的可观察形态是同 prefix 的
            // 进程一起卡住（pid 还在、不应答、stderr 安静），这里用 SIGSTOP 复现。
            if (scenario === 'prefix-contention' && canStopProcess) {
                stoppedSiblings = true
                for (const other of children) {
                    if (other === entry || isDead(other)) continue
                    try {
                        other.child.kill('SIGSTOP')
                    } catch {
                        /* 单个停不住不挡住其余 */
                    }
                }
            }
            return mode
        },

        async readIdentityFile() {
            try {
                return fs.readFileSync(path.join(stateDir, 'identity.json'), 'utf8')
            } catch {
                return ''
            }
        },

        teardown() {
            for (const entry of children) {
                // 一个收尾失败不能挡住其余：停过 SIGSTOP 必须先放开才能收到 SIGKILL
                try {
                    if (stoppedSiblings && canStopProcess) entry.child.kill('SIGCONT')
                    entry.child.kill('SIGKILL')
                } catch {
                    try {
                        entry.child.kill('SIGKILL')
                    } catch {
                        /* 已经死了 */
                    }
                }
            }
            upstreamServer?.closeAllConnections?.()
            upstreamServer?.close()
            try {
                // Windows 上刚 SIGKILL 的子进程可能还锁着文件，给它几次重试的余地
                fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
            } catch {
                throw new Error(`彩排的临时目录没清掉，需要手工清理系统临时目录下的 libmssdk-verify-*（里面有明文身份文件）`)
            }
        },
    }
}
