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
// Windows Node 20 实测），所以这条路径必须自己钉住：改口、排空、停监听、退出，且不依赖信号。
// 另钉一条：上一次运行留下的标志不能把新进程直接收掉。
test('关闭标志：写 closing.flag 触发收尾；启动时残留的标志被忽略', async () => {
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
    const readyz = () =>
        new Promise((resolve, reject) => {
            const request = http.request(
                { host: '127.0.0.1', port, path: '/readyz', agent: false },
                response => {
                    response.resume()
                    response.on('end', () => resolve(response.statusCode))
                },
            )
            request.on('error', reject)
            request.end()
        })
    try {
        workers[0].reportReady()
        // watcher 启动时会清掉上一次留下的标志：不触发收尾
        await new Promise(resolve => setTimeout(resolve, 400))
        assert.equal(fs.existsSync(flag), false, '启动时应当清掉上一次留下的标志')
        assert.equal(await readyz(), 200, '残留标志不该把新进程直接收掉')

        fs.writeFileSync(flag, '')
        let status = 0
        for (let attempt = 0; attempt < 100; attempt += 1) {
            status = await readyz()
            if (status === 503) break
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.equal(status, 503, '文件触发后 /readyz 应当立刻改口')

        for (let attempt = 0; attempt < 100 && exitCode === null; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.equal(exitCode, 0, '收尾序列走完后应按 onExit(0) 落定')
        assert.equal(fs.existsSync(flag), true, '标志不删：多进程共用 state 时不能由第一个看到的进程删掉')
    } finally {
        entry.stopWatching()
        await new Promise(resolve => entry.server.close(resolve))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
