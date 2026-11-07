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

/** 子进程环境：清掉宿主可能漏进去的配置，只认用例自己给的。 */
function childEnv(envOverrides) {
    const env = { ...process.env, LIBMSSDK_STATE_DIR: stateDir }
    // 设备号 / Cookie / 曲目 id / 模块路径都可能从宿主环境漏进子进程：清掉，用例只认自己给的
    for (const key of [
        'LIBMSSDK_DEVICE_ID',
        'LIBMSSDK_COOKIE',
        'LIBMSSDK_PROBE_TRACK_ID',
        'LIBMSSDK_TOKEN',
        'LIBMSSDK_BDMS_MODULE',
        'QISHUI_BDMS_PATH',
        'LIBMSSDK_CLIENT_DIR',
        'QISHUI_CLIENT_DIR',
    ]) {
        delete env[key]
    }
    return Object.assign(env, envOverrides)
}

async function runWith(envOverrides, ...args) {
    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { env: childEnv(envOverrides) })
        return { code: 0, stdout, stderr }
    } catch (error) {
        return { code: error.code ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' }
    }
}

/** bridge 要读 stdin：execFile 不关 stdin，不能让子进程一直等。 */
async function runWithStdin(envOverrides, input, ...args) {
    const child = spawn(process.execPath, [cli, ...args], { env: childEnv(envOverrides), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
        stdout += chunk
    })
    child.stderr.on('data', chunk => {
        stderr += chunk
    })
    // 子进程提前退出时 stdin 会 EPIPE：不接住就是整个测试文件挂掉，而不是这条用例失败。
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    // 等 close 而不是 exit：exit 先到，缓冲里的 stderr 可能还没读完。
    const [code] = await once(child, 'close')
    return { code, stdout, stderr }
}

async function run(...args) {
    return runWith({}, ...args)
}

/** 收集 JSON 里的全部字符串值：Windows 路径在 JSON 文本里被转义过，不能直接拿 stdout 做包含判断。 */
function stringValues(value, out = []) {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) for (const item of value) stringValues(item, out)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) stringValues(item, out)
    return out
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

const mockBdms = path.join(here, 'fixtures', 'mock-bdms.mjs')

test('selftest / config 默认隐掉本机路径，--verbose 才打原文', async () => {
    const cleanup = []
    try {
        // 模块路径放在 home 下但不创建：既覆盖 HOME 里的片段，也不往用户目录写东西。
        const modulePath = path.join(os.homedir(), 'libmssdk-redact-missing', 'bdms.node')
        const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-redact-state-'))
        cleanup.push(identityDir)
        const identityFile = path.join(identityDir, 'identity.json')
        // 客户端目录由 LOCALAPPDATA 自动探测出来：顺带钉住「APPDATA 下的路径也要隐掉」。
        const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-redact-appdata-'))
        cleanup.push(localAppData)
        const clientDir = path.join(localAppData, 'Programs', 'Soda Music', '3.7.0')
        fs.mkdirSync(clientDir, { recursive: true })
        const env = {
            LIBMSSDK_BDMS_MODULE: modulePath,
            LIBMSSDK_STATE_DIR: identityDir,
            LOCALAPPDATA: localAppData,
        }

        for (const command of ['config', 'selftest']) {
            const { code, stdout } = await runWith(env, command)
            assert.equal(code, command === 'selftest' ? 1 : 0, `${command} 的退出码`)
            const payload = JSON.parse(stdout)
            const strings = stringValues(payload)
            for (const leaked of [modulePath, os.homedir(), identityDir, identityFile, clientDir, localAppData]) {
                assert.equal(
                    strings.some(text => text.includes(leaked)),
                    false,
                    `${command} 的输出漏了本机路径 ${leaked}：${stdout}`,
                )
            }
            assert.equal(payload.bdmsModule, '(本机路径)', `${command} 要整条换掉显式模块路径`)
            assert.equal(payload.clientDir, '(本机路径)', `${command} 要整条换掉 APPDATA 下探测到的客户端目录`)
            if (command === 'config') {
                assert.equal(payload.identity.file, '(本机路径)', '身份文件路径默认整条换掉')
            } else {
                assert.equal(payload.identity, 'state (本机路径)', '身份文件路径默认整条换掉，不套两层括号')
                assert.equal(payload.error, 'bdms.node 不存在：(本机路径)', '报错原文里的模块路径也要换掉')
            }
        }

        // 排查「到底找的是哪个文件」靠显式开关，不靠默认输出。
        const verboseConfig = JSON.parse((await runWith(env, 'config', '--verbose')).stdout)
        assert.equal(verboseConfig.bdmsModule, modulePath)
        assert.equal(verboseConfig.clientDir, clientDir)
        assert.equal(verboseConfig.identity.file, identityFile)

        const verboseSelftest = JSON.parse((await runWith(env, 'selftest', '--verbose')).stdout)
        assert.equal(verboseSelftest.bdmsModule, modulePath)
        assert.equal(verboseSelftest.identity, `state (${identityFile})`)
        assert.equal(verboseSelftest.error.includes(modulePath), true, '--verbose 时错误里的原文要保留')
    } finally {
        for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('selftest 成功那支也不打本机路径，--verbose 才给原文', async () => {
    const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-redact-ok-'))
    const identityFile = path.join(identityDir, 'identity.json')
    const env = { LIBMSSDK_BDMS_MODULE: mockBdms, LIBMSSDK_STATE_DIR: identityDir }
    try {
        const { code, stdout } = await runWith(env, 'selftest')
        assert.equal(code, 0, 'mock 模块应当能出签名')
        const payload = JSON.parse(stdout)
        assert.equal(payload.signOk, true)
        assert.equal(payload.bdmsModule, '(本机路径)', '成功那支同样要整条换掉模块路径')
        assert.equal(payload.identity, 'state (本机路径)', '成功那支同样要换掉身份文件路径')
        const strings = stringValues(payload)
        for (const leaked of [mockBdms, os.homedir(), identityDir, identityFile]) {
            assert.equal(strings.some(text => text.includes(leaked)), false, `成功那支漏了本机路径 ${leaked}`)
        }

        const verbose = JSON.parse((await runWith(env, 'selftest', '--verbose')).stdout)
        assert.equal(verbose.signOk, true)
        assert.equal(verbose.bdmsModule, mockBdms)
        assert.equal(verbose.identity, `state (${identityFile})`)
    } finally {
        fs.rmSync(identityDir, { recursive: true, force: true })
    }
})

test('selftest 模块指向同名目录时，报错里只剩相对片段', async () => {
    // 票面上的复现：路径存在但加载不了，require 会带上 require stack，
    // 父目录先命中就会把 stack 里那条 src/bdms.mjs 剪成半截。
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-selftest-dir-'))
    const moduleDir = path.join(rootDir, 'dirnode')
    const modulePath = path.join(moduleDir, 'bdms.node')
    fs.mkdirSync(modulePath, { recursive: true })
    try {
        const { code, stdout } = await runWith({ LIBMSSDK_BDMS_MODULE: modulePath }, 'selftest')
        assert.equal(code, 1)
        const payload = JSON.parse(stdout)
        assert.equal(payload.signOk, false)
        assert.equal(payload.bdmsModule, '(本机路径)')
        const strings = stringValues(payload)
        for (const leaked of [rootDir, moduleDir, modulePath, os.homedir()]) {
            assert.equal(
                strings.some(text => text.includes(leaked)),
                false,
                `selftest 的输出漏了本机路径 ${leaked}：${stdout}`,
            )
        }
        assert.match(
            payload.error,
            new RegExp(`\\(本机路径\\)[\\\\/]src[\\\\/]bdms\\.mjs`),
            `require stack 里那条路径要整条换掉、不留半截：${payload.error}`,
        )
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true })
    }
})

test('bridge 失败时 stderr 不带本机路径，--verbose 才给原文', async () => {
    const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-bridge-missing-'))
    const modulePath = path.join(moduleDir, 'bdms.node')
    // 与 libresoda 的调用形状一致：stdin 一个 SignRequest，失败看 stderr。
    const payload = JSON.stringify({ url: 'https://api.qishui.com/luna/pc/track_v2?aid=1', headers: {} })
    try {
        const quiet = await runWithStdin({ LIBMSSDK_BDMS_MODULE: modulePath }, payload, 'bridge')
        assert.equal(quiet.code, 1, '模块不存在要让调用方看得出来')
        assert.equal(quiet.stdout, '', '失败时不该往 stdout 吐半截 JSON')
        assert.equal(quiet.stderr.includes(moduleDir), false, `stderr 漏了本机路径：${quiet.stderr}`)
        assert.equal(quiet.stderr.includes(modulePath), false, `stderr 漏了本机路径：${quiet.stderr}`)
        assert.match(quiet.stderr, /bdms\.node 不存在：\(本机路径\)/, '话要说全，只留「不存在」就够了')

        const verbose = await runWithStdin({ LIBMSSDK_BDMS_MODULE: modulePath }, payload, 'bridge', '--verbose')
        assert.equal(verbose.code, 1)
        assert.equal(verbose.stderr.includes(modulePath), true, '--verbose 时错误里的原文要保留')
    } finally {
        fs.rmSync(moduleDir, { recursive: true, force: true })
    }
})

test('显式模块路径不存在时 serve 拒启，错误里不带本机路径', async () => {
    const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-serve-missing-'))
    const modulePath = path.join(moduleDir, 'bdms.node')
    try {
        // 两个变量名都认：漏掉其中一个，用户拿旧名配的那条路就会绕过检查。
        for (const key of ['LIBMSSDK_BDMS_MODULE', 'QISHUI_BDMS_PATH']) {
            const { code, stdout, stderr } = await runWith({ [key]: modulePath }, 'serve')
            assert.equal(code, 1, `${key}：配置阶段就该停下，而不是起来后每条 /sign 都失败`)
            assert.equal(stdout, '', `${key}：拒启时不该先打启动日志`)
            const errorLine = stderr
                .split('\n')
                .filter(Boolean)
                .map(line => {
                    try {
                        return JSON.parse(line)
                    } catch {
                        return null
                    }
                })
                .find(line => line?.event === 'error')
            assert.ok(errorLine, `${key}：stderr 里没有 event=error：${stderr}`)
            assert.match(errorLine.message, /显式指定的 bdms\.node 不存在/)
            assert.equal(errorLine.message.includes(moduleDir), false, `${key}：错误里漏了本机路径：${errorLine.message}`)
            assert.match(errorLine.message, /\(本机路径\)/, `${key}：路径位置要给出「已被隐掉」的信号`)
        }
    } finally {
        fs.rmSync(moduleDir, { recursive: true, force: true })
    }
})

// 真进程的信号那一段：/readyz 之所以会「当场改口」，靠的是 index.mjs 的 SIGTERM 处理器
// 调到收尾序列。前面的用例只测到 beginShutdown() 那一层，管线和信号之间还隔着一条缝。
// Windows 不把 SIGTERM 投给进程（Node 文档写明不支持），这一条只在能收信号的平台跑。

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
                // 排空窗口给足，客户端才追得上「改口」那一下（轮询预算约 2 秒；
                // 高负载 runner 上信号落地 + 首次 fetch 会吃掉一截，窗口留到 5 秒）
                LIBMSSDK_DRAIN_DELAY_MS: '5000',
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
