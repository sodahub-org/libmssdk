// 黑盒多进程：真 fork、真 IPC、真 worker（src/worker.mjs），原生模块仍用 mock。
//
// 这一组只有真进程才测得到：预热判据要在一个独立的事件循环里自己收敛出「稳态」，
// 杀掉一台之后「在飞的请求被清理、槽位不永久停在忙」也只能用真退出验证。
//
// 不断言「第几个请求落到第几个 worker」——两个平台的分发模型不同，那种断言迟早会自己翻脸。
//
// 只留 #1「测试决定」规定的这一层的样子（1 到 2 条）：进程起得来、杀得掉、槽位收得回。
// 「worker 不许创建身份文件」属于身份模块的契约，那边已有只读入口与独占创建的用例。

import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const mockBdms = path.join(here, 'fixtures', 'mock-bdms.mjs')

const { forkWorker } = await import('../src/dispatcher.mjs')
const { startServe } = await import('../src/serve.mjs')
const { BdmsSigner } = await import('../src/bdms.mjs')
const { maskDeviceId } = await import('../src/config.mjs')
const { prepareStoredIdentity } = await import('../src/identity.mjs')

const config = {
    version: 'test',
    host: '127.0.0.1',
    token: '',
    deviceId: '7000000000000001',
    maxBodyBytes: 256 * 1024,
}

const running = []

after(async () => {
    for (const entry of running) {
        await entry.pool.stop()
        for (const child of entry.children) child.kill()
        await new Promise(resolve => entry.server.close(resolve))
    }
    // 断在中间也要收：临时目录留在 os.tmpdir 里没人负责删
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const tempDirs = []

/** 临时目录要活到用例结束（worker 重生时还要再读一次），所以只在收工后统一删。 */
function tempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
}

function tempStateDir() {
    return tempDir('libmssdk-worker-')
}

/** 起一套真的：按默认服务（src/serve.mjs）的生产装配，只把 fork 包一层好拿到进程句柄。 */
async function startReal({ workers, unstableCalls = 0, signDelayMs = 0, stateDir, deviceId, traceDir = '' }) {
    const children = []
    const notes = []
    const giveUps = []
    const env = {
        ...process.env,
        LIBMSSDK_WORKERS: String(workers),
        LIBMSSDK_BDMS_MODULE: mockBdms,
        // 给了 stateDir 就不钉设备号：那才是真部署的样子 —— 主进程 fork 之前把身份准备好，
        // worker 那边只有只读入口
        LIBMSSDK_DEVICE_ID: stateDir ? '' : deviceId || config.deviceId,
        LIBMSSDK_WORKER_RESPAWN_BASE_MS: '100',
        LIBMSSDK_WORKER_RESPAWN_CAP_MS: '400',
        LIBMSSDK_WARMUP_BUDGET_MS: '20000',
        // 限流默认生效；这里固定成强制模式，避免外部 shell 的环境变量影响用例
        LIBMSSDK_RATE_LIMIT_MODE: 'enforce',
        LIBMSSDK_RATE_LIMIT_MODE_FILE: '',
        MOCK_BDMS_UNSTABLE_CALLS: String(unstableCalls),
        MOCK_BDMS_SIGN_DELAY_MS: String(signDelayMs),
        MOCK_BDMS_TRACE_DIR: traceDir,
    }
    if (stateDir) env.LIBMSSDK_STATE_DIR = stateDir
    if (stateDir) delete env.LIBMSSDK_DEVICE_ID
    const signer = new BdmsSigner({ modulePath: mockBdms, deviceId: deviceId || config.deviceId })
    const entry = startServe({
        config: { ...config, deviceId: deviceId || config.deviceId },
        signer,
        env,
        log: (event, detail) => notes.push({ event, detail }),
        spawn: (index, childEnv) => {
            const child = forkWorker(index, childEnv)
            children.push(child)
            return child
        },
        onGiveUp: () => giveUps.push(Date.now()),
    })
    await new Promise(resolve => entry.server.listen(0, '127.0.0.1', resolve))
    const address = entry.server.address()
    entry.baseUrl = `http://127.0.0.1:${address.port}`
    entry.children = children
    entry.notes = notes
    entry.giveUps = giveUps
    running.push(entry)
    return entry
}

function until(condition, describe, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (condition()) return resolve()
            if (Date.now() > deadline) return reject(new Error(`等不到：${describe}`))
            setTimeout(poll, 10)
        }
        poll()
    })
}

const signPayload = (overrides = {}) => ({
    url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088&device_id=7000000000000001',
    method: 'POST',
    body: '{"track_id":"7501674235158431760"}',
    headers: { 'x-ss-stub': 'ABC', cookie: 'sid=1' },
    ...overrides,
})

async function post(baseUrl, payload) {
    const response = await fetch(`${baseUrl}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
    })
    return { status: response.status, text: await response.text() }
}

test('真进程：身份只读、预热自学习、杀在飞的那台之后槽位收得回', async () => {
    // 主进程 fork 之前先把身份准备好；worker 那条路径上只有 readStoredIdentity
    // 前两次输出比稳态短（真机 init 之后就有这么一段窗口），单次调用同步占住 300ms
    const dir = tempStateDir()
    const prepared = prepareStoredIdentity({ dir })
    const before = fs.readFileSync(path.join(dir, 'identity.json'), 'utf8')
    const { pool, children, notes, baseUrl } = await startReal({
        workers: 1,
        unstableCalls: 2,
        signDelayMs: 300,
        stateDir: dir,
        deviceId: prepared.identity.device_id,
    })

    await until(() => pool.readyCount === 1, 'worker 自学习到就绪')

    // 默认装配的过渡端点也要在：Docker 健康检查与 verify/wine-multi 都还指着它们（#9 再收拢）
    const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(health.status, 200)
    const healthPayload = await health.json()
    assert.equal(healthPayload.ready, true, '至少一台 worker 就绪才回 200')
    assert.equal(healthPayload.deviceId, maskDeviceId(prepared.identity.device_id))

    const configResponse = await fetch(`${baseUrl}/config`, { signal: AbortSignal.timeout(5000) })
    assert.equal(configResponse.status, 200)
    const configPayload = await configResponse.json()
    assert.equal(configPayload.identity.device_id, prepared.identity.device_id, '过渡端点看到的仍是同一份身份')
    assert.equal(configPayload.trustProxy, false, '默认不信任 X-Forwarded-For')

    // /stat 走默认装配：真 worker 数、队列深度、限流状态都要对得上，且地址字段不存在完整 IP
    const statResponse = await fetch(`${baseUrl}/stat`, { signal: AbortSignal.timeout(5000) })
    assert.equal(statResponse.status, 200)
    const statPayload = await statResponse.json()
    assert.equal(statPayload.workers.total, 1)
    assert.equal(statPayload.workers.ready, 1)
    assert.equal(statPayload.queue.depth, 0)
    assert.equal(statPayload.rateLimit.mode, 'enforce')
    assert.equal(statPayload.rateLimit.burst, 12)

    const anonymous = await post(baseUrl, {
        url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088',
        method: 'POST',
        headers: { 'x-ss-stub': 'ABC' },
    })
    assert.equal(
        JSON.parse(anonymous.text).device_id,
        prepared.identity.device_id,
        '没在 URL 里点名的请求，用的是主进程落在文件里的那份身份',
    )
    assert.equal(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'), before, 'worker 不许改写身份文件')
    assert.deepEqual(fs.readdirSync(dir), ['identity.json'], '目录里没多出东西：worker 手上没有创建路径')

    const started = notes.find(note => note.event === 'dispatcher')
    assert.equal(started.detail.workers, 1, '启动日志要写明实际值')
    assert.match(started.detail.reason, /LIBMSSDK_WORKERS=1/, '还要写明这个数是谁给的')
    assert.equal(started.detail.trustProxy, false, '启动日志要写明是否信任 XFF')

    const pending = post(baseUrl, signPayload())
    await until(() => pool.busyCount === 1, '真 worker 正在算这一份签名')
    children.at(-1).kill('SIGKILL')

    const killed = await pending
    assert.equal(killed.status, 500, `进程死在计算中途：${killed.text.slice(0, 120)}`)
    assert.match(killed.text, /"code":"INTERNAL_ERROR"/)

    // 槽位不能永久停在忙：退避重生 + 重新预热之后，同一个位置要再次接得住活
    await until(() => children.length === 2 && pool.readyCount === 1, '重生并重新就绪')
    await until(() => pool.busyCount === 0, '死掉那次的在飞状态已被清理')
    const recovery = await post(baseUrl, signPayload())
    assert.equal(recovery.status, 200)
    const payload = JSON.parse(recovery.text)
    assert.equal(payload.headers['X-Helios'].startsWith('mock-helios-'), true)
    assert.equal(payload.headers['X-Medusa'].startsWith('mock-medusa-'), true)
    // 收工前确认这台 worker 从头到尾没碰过身份文件
    assert.equal(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'), before)
})



test('真进程多开：并发确实重叠，杀掉一台其余继续服务', async () => {
    const traceDir = tempDir('libmssdk-trace-')
    const { pool, children, baseUrl } = await startReal({ workers: 2, signDelayMs: 500, traceDir })

    await until(() => pool.readyCount === 2, '两台都自学习到就绪')

    // 并行性用「两次签名的起止时间是否重叠」证明，不用总耗时阈值 —— 慢 CI 上墙钟断言会自己翻脸。
    const [left, right] = await Promise.all([
        post(baseUrl, signPayload({ url: 'https://api.qishui.com/luna/pc/track_v2?probe=parallel-a' })),
        post(baseUrl, signPayload({ url: 'https://api.qishui.com/luna/pc/track_v2?probe=parallel-b' })),
    ])
    assert.equal(left.status, 200)
    assert.equal(right.status, 200)
    const traces = fs
        .readdirSync(traceDir)
        .map(file => JSON.parse(fs.readFileSync(path.join(traceDir, file), 'utf8')))
    const a = traces.find(trace => trace.url.includes('parallel-a'))
    const b = traces.find(trace => trace.url.includes('parallel-b'))
    assert.ok(a && b, '两次并发签名都该留下起止记录')
    assert.ok(
        a.startedAt < b.endedAt && b.startedAt < a.endedAt,
        `两次签名没有重叠（没有并行）：a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
    )

    // 两台此刻都闲着：杀其中一台，剩下的那台必须立刻独挑大梁
    children[0].kill()
    await once(children[0], 'exit')
    assert.equal(pool.readyCount, 1, '没了的那台不再算进「能服务」')

    const survivor = await post(baseUrl, signPayload())
    assert.equal(survivor.status, 200, '一台死了不该让客户端感到停机')

    await until(() => pool.readyCount === 2, '退避之后补齐到两台')
    assert.equal((await post(baseUrl, signPayload())).status, 200)
})
