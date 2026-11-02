// 收尾收池子这一下最怕「失败把收尾挂住」：同步抛会让 server.close 的回调走不到 resolve，
// reject 则是一条无人处理的 rejection（进程照样 exit 0，失败静默）。
// 两种形状都必须落定，且错误文本要按本机路径脱敏 —— 日志是公开求助时最常被贴出去的东西。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const { startServe, stopPoolQuietly } = await import('../src/serve.mjs')
const { FakeWorker } = await import('./helpers/fake-worker.mjs')

/** logError 直接写 stderr；用例临时接管，既能断言「记了一笔」，也能检查脱敏。 */
async function captureStderr(run) {
    const original = process.stderr.write
    let output = ''
    process.stderr.write = (chunk, ...rest) => {
        output += String(chunk)
        // 保持 write 的返回约定；后面的 encoding/callback 参数照常交给原实现用不到，直接忽略
        void rest
        return true
    }
    try {
        await run()
    } finally {
        process.stderr.write = original
    }
    return output
}

test('stopPoolQuietly：两种失败形状都会落定、各记一笔，并按给定位置脱敏', async () => {
    const calls = []
    // 用一个不含反斜杠的哨兵：JSON.stringify 不会改写它，Windows 上「没出现」才是真的没出现
    const fakePath = 'libmssdk-fake-module-path-4f2a'
    const output = await captureStderr(async () => {
        await stopPoolQuietly(
            {
                stop: () => {
                    calls.push('sync')
                    throw new Error(`sync ${fakePath}`)
                },
            },
            [fakePath],
        )
        await stopPoolQuietly(
            {
                stop: () => {
                    calls.push('async')
                    return Promise.reject(new Error(`async ${fakePath}`))
                },
            },
            [fakePath],
        )
    })

    assert.deepEqual(calls, ['sync', 'async'], '两种形状都要真的调到 pool.stop；不调也会「落定」')
    assert.equal((output.match(/pool\.stop:/g) || []).length, 2, '每条失败都要各记一笔，不能有一条静默丢掉')
    assert.equal(output.includes(fakePath), false, '显式传入的位置必须被换掉')
    assert.equal((output.match(/\(本机路径\)/g) || []).length, 2, '两条错误的路径都要脱敏')
})

// 容器形态的主触发源：state 目录下的 closing.flag。容器里的 SIGINT 到不了 Node（Wine 11 +
// Windows Node 20 实测），所以这条路径必须自己钉住：改口、在飞请求收完、停监听、退出，
// 且不依赖信号。另钉两条：启动时残留的标志不算触发；文件与信号同时触发只跑一次收尾。
test('关闭标志：写 closing.flag 触发收尾；残留标志忽略、在飞请求收完、只收尾一次', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-close-'))
    const identityFile = path.join(dir, 'identity.json')
    const flag = path.join(dir, 'closing.flag')
    fs.writeFileSync(identityFile, '{"device_id":"7000000000000001"}')
    fs.writeFileSync(flag, 'stale')

    const workers = []
    let exitCode = null
    const entry = startServe({
        config: {
            version: 'test',
            host: '127.0.0.1',
            token: '',
            deviceId: '7000000000000001',
            maxBodyBytes: 256 * 1024,
            identityPersisted: true,
            identityFile,
            drainDelayMs: 300,
        },
        env: { LIBMSSDK_WORKERS: '1' },
        log: () => {},
        onExit: code => {
            exitCode = code
        },
        spawn: index => {
            const worker = new FakeWorker(index)
            workers.push(worker)
            return worker
        },
    })
    await new Promise(resolve => entry.server.listen(0, '127.0.0.1', resolve))
    const { port } = entry.server.address()
    const exchange = (path, options = {}) =>
        new Promise((resolve, reject) => {
            const request = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path,
                    agent: false,
                    method: options.method || 'GET',
                    headers: options.headers,
                },
                response => {
                    const chunks = []
                    response.on('data', chunk => chunks.push(chunk))
                    response.on('end', () =>
                        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
                    )
                },
            )
            request.on('error', reject)
            request.end(options.body)
        })
    const readyz = () => exchange('/readyz').then(response => response.status)
    try {
        workers[0].reportReady()
        // 启动时就在的标志按基线忽略：不触发收尾，也不删（删了会抢别人的触发）
        await new Promise(resolve => setTimeout(resolve, 400))
        assert.equal(fs.existsSync(flag), true, '启动时不该删掉别人的标志')
        assert.equal(await readyz(), 200, '残留标志不该把新进程直接收掉')

        // 真的在飞的一单：文件触发后它仍应算完
        const pending = exchange('/sign', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://api.qishui.com/x', method: 'POST', headers: { 'x-ss-stub': 'A' } }),
        })
        for (let attempt = 0; attempt < 100 && !workers[0].task(); attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.ok(workers[0].task(), '在飞请求应当已经派到 worker')

        fs.writeFileSync(flag, 'stop')
        let status = 0
        for (let attempt = 0; attempt < 100; attempt += 1) {
            status = await readyz()
            if (status === 503) break
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.equal(status, 503, '文件触发后 /readyz 应当立刻改口')

        // 第二条触发源（信号路径）再调一次：必须复用同一个收尾，不能再给 worker 发一遍 shutdown
        entry.beginShutdown()

        workers[0].reportResult()
        const signed = await pending
        assert.equal(signed.status, 200, '在飞请求在排空窗口里算完，客户端拿到回包而不是连接重置')

        for (let attempt = 0; attempt < 100 && exitCode === null; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.equal(exitCode, 0, '收尾序列走完后应按 onExit(0) 落定')
        assert.equal(fs.existsSync(flag), true, '标志不删：多进程共用 state 时不能由第一个看到的进程删掉')
        const shutdowns = workers[0].sent.filter(message => message.type === 'shutdown').length
        assert.equal(shutdowns, 1, '两个触发源只该跑一次收尾')
    } finally {
        entry.stopWatching()
        await new Promise(resolve => entry.server.close(resolve))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
