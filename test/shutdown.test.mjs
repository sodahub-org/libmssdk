// 收尾收池子这一下最怕「失败把收尾挂住」：同步抛会让 server.close 的回调走不到 resolve，
// reject 则是一条无人处理的 rejection（进程照样 exit 0，失败静默）。
// 两种形状都必须落定，且错误文本要按本机路径脱敏 —— 日志是公开求助时最常被贴出去的东西。

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { stopPoolQuietly } = await import('../src/serve.mjs')

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

test('stopPoolQuietly：同步抛与 reject 都会落定，错误按本机路径脱敏', async () => {
    const calls = []
    const localPath = process.cwd()
    const output = await captureStderr(async () => {
        await stopPoolQuietly({
            stop: () => {
                calls.push('sync')
                throw new Error(`boom ${localPath}/sync`)
            },
        })
        await stopPoolQuietly({
            stop: () => {
                calls.push('async')
                return Promise.reject(new Error(`boom ${localPath}/async`))
            },
        })
    })

    assert.deepEqual(calls, ['sync', 'async'], '两种形状都要真的调到 pool.stop；不调也会「落定」')
    assert.match(output, /\(本机路径\)/, '错误文本要按本机路径脱敏')
    assert.equal(output.includes(localPath), false, '原始本机路径不该出现在日志里')
})
