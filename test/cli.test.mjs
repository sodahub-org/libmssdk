// 命令行入口的黑盒用例：只跑不会出网的那几条路径。
//
// #9 把 /probe 收成命令行子命令，于是「子命令在不在、参数解析对不对、失败形态可不可读」
// 需要一份外部证据。真打上游那条路不在这里跑：npm test 不许出网，那是 tools/ 与手动自检的领域。
//
// 每条用例都自带一个临时 LIBMSSDK_STATE_DIR：入口在 import 阶段就会准备身份文件，
// 不能让它写进仓库的 data/。

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'src', 'index.mjs')
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-cli-'))

after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

async function run(...args) {
    const env = { ...process.env, LIBMSSDK_STATE_DIR: stateDir }
    // 设备号 / Cookie / 曲目 id 都可能从宿主环境漏进子进程：清掉，用例只认命令行参数
    for (const key of ['LIBMSSDK_DEVICE_ID', 'LIBMSSDK_COOKIE', 'LIBMSSDK_PROBE_TRACK_ID', 'LIBMSSDK_TOKEN']) {
        delete env[key]
    }
    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { env })
        return { code: 0, stdout, stderr }
    } catch (error) {
        return { code: error.code ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' }
    }
}

test('probe 子命令在，缺 track_id 时非零退出并说清缺什么', async () => {
    const { code, stdout, stderr } = await run('probe')
    assert.equal(code, 1, '缺参数要非零退出，脚本才判断得了')
    assert.match(stderr, /track_id 不能为空/, `失败形态要可读：${stderr}`)
    assert.equal(stdout, '', '出错的这条命令不该往 stdout 吐半截 JSON')
})

test('未知命令把可用的子命令列出来，probe 在其中', async () => {
    const { code, stdout } = await run('definitely-not-a-command')
    assert.equal(code, 2)
    assert.match(stdout, /serve \/ bridge \/ selftest \/ probe \/ config/)
})

test('config 命令的 stdout 是一个可解析的对象，设备号只出脱敏值', async () => {
    const { code, stdout } = await run('config')
    assert.equal(code, 0)
    const payload = JSON.parse(stdout)
    assert.match(payload.identity.deviceId, /^\d{3}\*\*\*\d{3}$/, '只出前 3 后 3')
    assert.equal(/\d{16}/.test(stdout), false, '完整设备号（16 位）不该出现在输出里')
    assert.equal(payload.identity.persisted, true, '临时 state 目录可写，身份应当落盘')
})

// 真进程的信号那一段：/readyz 之所以会「当场改口」，靠的是 index.mjs 的 SIGTERM 处理器
// 调到收尾序列。前面的用例只测到 beginShutdown() 那一层，管线和信号之间还隔着一条缝。
// Windows 不把 SIGTERM 投给进程（Node 文档写明不支持），这一条只在能收信号的平台跑。
const mockBdms = path.join(here, 'fixtures', 'mock-bdms.mjs')

test(
    '真进程收到 SIGTERM：先改口 /readyz，排空窗口结束后才退出',
    { skip: process.platform === 'win32' ? 'Windows 不投递 SIGTERM（Node 文档写明不支持）' : false, timeout: 60000 },
    async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-sigterm-'))
        const child = spawn(process.execPath, [cli, 'serve'], {
            env: {
                ...process.env,
                LIBMSSDK_STATE_DIR: dir,
                LIBMSSDK_DEVICE_ID: '7000000000000001',
                LIBMSSDK_BDMS_MODULE: mockBdms,
                LIBMSSDK_BIND: '127.0.0.1',
                // 端口交给系统分配：自选端口在 Windows CI 上会撞上一次绑定的 TIME_WAIT
                LIBMSSDK_PORT: '0',
                LIBMSSDK_WORKERS: '1',
                LIBMSSDK_WARMUP_BUDGET_MS: '20000',
                LIBMSSDK_RATE_LIMIT_MODE: 'off',
                LIBMSSDK_RATE_LIMIT_MODE_FILE: '',
                // 排空窗口给足，客户端才追得上「改口」那一下（轮询预算约 2 秒）
                LIBMSSDK_DRAIN_DELAY_MS: '2000',
                LIBMSSDK_TOKEN: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', chunk => {
            stderr += chunk
        })
        const exited = once(child, 'exit')
        try {
            // 启动日志的 event=serve 带着实际监听地址，端口是 listen(0) 分配的那个
            let stdout = ''
            child.stdout.setEncoding('utf8')
            const port = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`10 秒内没等到 event=serve\nstderr: ${stderr}`)), 10000)
                child.stdout.on('data', chunk => {
                    stdout += chunk
                    for (const line of stdout.split('\n')) {
                        try {
                            const event = JSON.parse(line)
                            if (event.event === 'serve') {
                                clearTimeout(timer)
                                resolve(Number(new URL(event.url).port))
                            }
                        } catch {
                            // 半行 JSON：下一块数据到齐再解析
                        }
                    }
                })
                child.once('exit', code => {
                    clearTimeout(timer)
                    reject(new Error(`serve 提前退出 code=${code}\nstderr: ${stderr}`))
                })
            })

            const base = `http://127.0.0.1:${port}`
            let ready = 0
            for (let attempt = 0; attempt < 400; attempt += 1) {
                try {
                    ready = (await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2000) })).status
                } catch {
                    ready = 0
                }
                if (ready === 200) break
                await new Promise(resolve => setTimeout(resolve, 50))
            }
            assert.equal(ready, 200, `worker 没在预算内就绪\nstderr: ${stderr}`)

            child.kill('SIGTERM')
            // 信号处理器是异步落地的：在排空窗口内轮询，直到读到 503
            let shutting = 0
            for (let attempt = 0; attempt < 100; attempt += 1) {
                try {
                    shutting = (await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2000) })).status
                } catch {
                    shutting = 0
                }
                if (shutting === 503) break
                await new Promise(resolve => setTimeout(resolve, 20))
            }
            assert.equal(shutting, 503, 'SIGTERM 之后第一件事是让 /readyz 改口')

            const [code] = await exited
            assert.equal(code, 0, `收尾应当正常退出\nstderr: ${stderr}`)

            // 排空窗口之后才停监听：此刻已经连不上了，且不是又一个 503
            await assert.rejects(fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2000) }))
        } finally {
            child.kill('SIGKILL')
            fs.rmSync(dir, { recursive: true, force: true })
        }
    },
)
