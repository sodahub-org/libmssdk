// 签名之外的那张 HTTP 脸：健康检查（/livez、/readyz 与 /healthz 别名）与旧诊断端点的弃用回执。
//
// 接缝沿用 #1「测试决定」里已经约定的那两个：真 HTTP（listen(0)）+ 注入的 worker 池，
// 断言的都是可以外部观察的事实（状态码、响应头、回包里有什么），不看内部变量。
//
// 端口只用 listen(0)：Windows 上自选端口会撞上上一次绑定的 TIME_WAIT，
// 「先探测空闲端口再绑定」这个两步模式在该平台实测大面积失败。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))

const { createServiceHandler, SUNSET_HTTP_DATE } = await import('../src/endpoints.mjs')
const { createDispatcher } = await import('../src/dispatcher.mjs')
const { startServe } = await import('../src/serve.mjs')
const { fakePool, signedBody } = await import('./helpers/fake-pool.mjs')
const { FakeWorker } = await import('./helpers/fake-worker.mjs')
const { rawExchange } = await import('./helpers/raw-request.mjs')

const config = {
    version: 'test',
    host: '127.0.0.1',
    token: 'test-token',
    deviceId: '7000000000000001',
    maxBodyBytes: 256 * 1024,
}

const servers = []

after(async () => {
    for (const server of servers) await new Promise(resolve => server.close(resolve))
})

/** 只挂端点处理器：默认服务里它是分发器的 fallback，这里单独建服务就是为了真 HTTP 观察。 */
async function serveHandler(options) {
    const server = http.createServer(createServiceHandler({ config, ...options }))
    servers.push(server)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

const signPayload = (overrides = {}) => ({
    url: 'https://api.qishui.com/luna/pc/track_v2?aid=386088&device_id=7000000000000001',
    method: 'POST',
    body: '{"track_id":"1"}',
    headers: { 'x-ss-stub': 'ABC', cookie: 'sid=1' },
    ...overrides,
})

async function postSign(baseUrl, payload) {
    const response = await fetch(`${baseUrl}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
    })
    return { status: response.status, text: await response.text() }
}

/** 真 HTTP 要跑几个事件循环才落到 handler，所以条件轮询而不是猜一个 tick。 */
async function until(condition, describe) {
    for (let attempt = 0; attempt < 500; attempt += 1) {
        if (condition()) return
        await new Promise(resolve => setTimeout(resolve, 1))
    }
    throw new Error(`等不到：${describe}`)
}

test('GET /livez 恒 200，而且一次都不问就绪判据', async () => {
    let asked = 0
    const { baseUrl } = await serveHandler({
        readiness: () => {
            asked += 1
            return false
        },
    })

    const response = await fetch(`${baseUrl}/livez`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200, '进程还在就该 200，跟 worker 没关系')
    assert.equal((await response.json()).ok, true)
    assert.equal(asked, 0, '轻量端点不许触发任何计算')
    assert.equal(response.headers.get('retry-after'), null, '探针的回包不参与 /sign 的错误契约')
})

test('GET /readyz：有就绪 worker 才 200，零 worker 或正在关闭时 503', async () => {
    let ready = false
    let closing = false
    const { baseUrl } = await serveHandler({ readiness: () => ready && !closing })

    const warming = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(warming.status, 503, '预热未完成时不能让编排器以为已就绪')
    assert.equal((await warming.json()).ready, false)

    ready = true
    const serving = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(serving.status, 200)
    assert.equal((await serving.json()).ready, true)

    closing = true
    const shutting = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(shutting.status, 503, '已经在收尾了就不该再被当成能服务')
    assert.equal((await shutting.json()).ready, false)
})

test('GET /healthz 保留为 /readyz 的别名：两种状态都一样', async () => {
    let ready = false
    const { baseUrl } = await serveHandler({ readiness: () => ready })

    for (const path of ['/healthz', '/readyz']) {
        const warming = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5000) })
        assert.equal(warming.status, 503, `${path} 未就绪`)
        assert.equal((await warming.json()).ready, false)
    }

    ready = true
    const [legacy, canonical] = await Promise.all([
        fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
        fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
    ])
    assert.equal(legacy.ready, true, '老编排配置不改也还能用')
    assert.deepEqual(legacy, canonical, '别名与规范端点回的是同一份内容')
})

test('GET /readyz 不泄露凭据：设备号只出脱敏值，令牌一个字节都不出现', async () => {
    const { baseUrl } = await serveHandler({ readiness: () => true })
    const payload = await (await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })).json()
    assert.equal(payload.deviceId, '700***001')
    assert.equal(payload.auth, true)
    const text = JSON.stringify(payload)
    assert.equal(text.includes(config.deviceId), false, '完整设备号不该出现在回包里')
    assert.equal(text.includes(config.token), false, '令牌不该出现在回包里')
})

// 队列饱满不改口：过载时把自己从上游摘掉，剩下的实例只会更忙，这是标准的死亡螺旋。
// 过载的信号走普通请求路径的 503，不走就绪端点。
test('忙到当场拒 /sign 的时候，/readyz 仍说「能服务」', async () => {
    const pool = fakePool({ size: 1 })
    const server = createDispatcher({
        config: { ...config, waitBudgetMs: 5000, queueLimit: 1 },
        pool,
        log: () => {},
        fallback: createServiceHandler({ config, readiness: () => pool.readyCount > 0 }),
    })
    servers.push(server)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${server.address().port}`

    // 唯一那台占住在飞，队列又只有 1 个位置：两条并发请求里必有一条被当场拒
    const held = pool.lease()
    held.run({ url: 'https://api.qishui.com/held' })
    await until(() => pool.requests.length === 1, '占位请求进入 worker')
    const first = postSign(baseUrl, signPayload())
    const second = postSign(baseUrl, signPayload())
    const rejected = await Promise.race([first, second])
    assert.equal(rejected.status, 503, '服务此刻确实忙不过来')
    assert.match(rejected.text, /"code":"BUSY"/)

    const ready = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(ready.status, 200, '队列饱满不该翻成就绪端点的 503')

    // 收干净：腾出的槽位接住排着的那一条
    pool.complete(held.id, { kind: 'SUCCESS', body: signedBody() })
    await until(() => pool.requests.length === 2, '排队的请求接住了腾出的槽位')
    pool.complete(pool.requests[1].slotId, { kind: 'SUCCESS', body: signedBody() })
    await Promise.all([first, second])
})

// 弃用节奏（#1 定的）：本版本只给「弃用 + 到期」信号并指向命令行，410 留给下一版本，
// 但不许变成静默 404 —— 升级的人要能在回包里看懂发生了什么。
test('旧诊断端点只回弃用回执：指向命令行，一次上游都不打', async () => {
    const originalFetch = globalThis.fetch
    const upstreamCalls = []
    globalThis.fetch = async url => {
        upstreamCalls.push(String(url))
        return new Response('{}', { status: 200 })
    }
    try {
        const { baseUrl } = await serveHandler({ readiness: () => true })
        const cases = [
            ['/probe', /node src\/index\.mjs probe/],
            ['/track/stream', /客户端/],
        ]
        for (const [path, replacement] of cases) {
            // 注意用保留下来的 originalFetch 打本机服务，否则会被上面那个上游桩拦掉
            const response = await originalFetch(`${baseUrl}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ track_id: '7501674235158431760', cookie: 'sessionid_ss=caller-cookie' }),
                signal: AbortSignal.timeout(5000),
            })
            assert.equal(response.status, 404, `${path}：本版本还没到 410`)
            assert.equal(response.headers.get('deprecation'), 'true', `${path}：要带弃用信号`)
            assert.equal(response.headers.get('sunset'), SUNSET_HTTP_DATE, `${path}：要带到场时间`)
            const payload = await response.json()
            assert.equal(payload.ok, false)
            assert.equal(payload.code, 'endpoint_removed', '稳定原因码，不是裸的 not_found')
            assert.match(payload.replacement, replacement, `${path}：回包里要写明替代做法`)
            assert.equal(payload.error.includes('sessionid_ss'), false, '调用方发来的 Cookie 不回显')
            assert.equal(response.headers.get('retry-after'), null, '改用命令行没有「再等一秒」这一说')
        }
        // 认得这条路就行，不看方法：拿 GET 敲旧端点的人同样要看得懂发生了什么
        const viaGet = await originalFetch(`${baseUrl}/probe`, { signal: AbortSignal.timeout(5000) })
        assert.equal(viaGet.status, 404)
        assert.equal(viaGet.headers.get('deprecation'), 'true')
        assert.equal(viaGet.headers.get('sunset'), SUNSET_HTTP_DATE)
    } finally {
        globalThis.fetch = originalFetch
    }
    assert.deepEqual(upstreamCalls, [], 'HTTP 层不再有任何向上游发请求的路径')
})

test('GET /config 已删除：普通 404，既不签名也不带弃用头', async () => {
    const { baseUrl } = await serveHandler({ readiness: () => true })
    for (const path of ['/config', '/never-heard-of-it']) {
        const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5000) })
        assert.equal(response.status, 404, `${path} 不再提供`)
        assert.match(await response.text(), /"code":"not_found"/)
        assert.equal(response.headers.get('deprecation'), null, `${path} 不是弃用中的端点，不该带信号`)
    }
})

test('Sunset 头是合法的 HTTP-date', () => {
    assert.match(SUNSET_HTTP_DATE, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/)
    assert.equal(Number.isNaN(Date.parse(SUNSET_HTTP_DATE)), false, '日期写错了编排器会整个忽略这个头')
})

// 畸形请求目标在修复前是 handler 里的 unhandled rejection（Node 15+ 直接退进程），
// 一条匿名 `GET //` 就能把服务带走。这里断言的是「进程还在、后面的请求还通」。
test('畸形请求目标与畸形 Host 不会退掉进程', async () => {
    const ready = true
    const { server, baseUrl } = await serveHandler({ readiness: () => ready })
    const port = server.address().port

    const malformed = await rawExchange(port, { requestLine: 'GET //' })
    assert.equal(malformed.error, null, `连接不该被重置：${malformed.error?.code || ''}`)
    assert.match(malformed.text, /^HTTP\/1\.1 404 /, '畸形目标按「没这条路由」处理')

    const badHost = await rawExchange(port, { requestLine: 'GET /healthz', headers: { host: 'a b' } })
    assert.match(badHost.text, /^HTTP\/1\.1 200 /, 'Host 不参与解析：就绪检查照旧')
    assert.match(badHost.text, /"ready":true/)

    const stillUp = await fetch(`${baseUrl}/livez`, { signal: AbortSignal.timeout(5000) })
    assert.equal(stillUp.status, 200, '进程还活着')
})

// 这条是结构守卫，不是行为断言：#1 要的是「上游调用收敛到一个内部模块，HTTP 层不留任何入口
// —— 防止日后又有人给它加一个路由」。行为用例只能证明「现在这几条路由不发请求」，
// 挡不住下一个人新加一条。
test('出网只此一处：HTTP 层与命令行都不自己向上游发请求', () => {
    const source = name => fs.readFileSync(path.join(here, '..', 'src', name), 'utf8')
    // fetch() 只许出现在 src/probe.mjs：命令行经 probeTrack，手动脚本也走同一条
    for (const name of ['endpoints.mjs', 'dispatcher.mjs', 'serve.mjs', 'auth.mjs', 'route.mjs', 'worker.mjs', 'index.mjs']) {
        assert.equal(/\bfetch\(/.test(source(name)), false, `${name} 里不该出现 fetch()：上游调用只许在 src/probe.mjs`)
    }
    // HTTP 层连「引用上游模块」都不该有：留了 import，下一个人就知道怎么加路由
    for (const name of ['endpoints.mjs', 'dispatcher.mjs', 'serve.mjs', 'worker.mjs', 'contract.mjs', 'errors.mjs']) {
        assert.equal(/probe\.mjs/.test(source(name)), false, `${name} 不该引用 src/probe.mjs`)
    }
})

// 默认装配（src/serve.mjs）才是编排器实际问的那个端点：答案要来自真的 worker 池，
// 而且一开始收尾就得当场改口。
test('默认装配：worker 报告就绪才 200，开始收尾就 503', async () => {
    const workers = []
    const entry = startServe({
        config: { ...config, identityPersisted: true },
        env: { LIBMSSDK_WORKERS: '1' },
        log: () => {},
        spawn: index => {
            const worker = new FakeWorker(index)
            workers.push(worker)
            return worker
        },
    })
    servers.push(entry.server)
    await new Promise(resolve => entry.server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${entry.server.address().port}`
    const readyz = async () => (await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })).status

    assert.equal(await readyz(), 503, 'worker 还没报告就绪，不能谎报已就绪')
    workers[0].reportReady()
    assert.equal(await readyz(), 200)

    entry.markClosing()
    assert.equal(await readyz(), 503, '已经在收尾了，就不该再被当成能服务')
    const live = await fetch(`${baseUrl}/livez`, { signal: AbortSignal.timeout(5000) })
    assert.equal(live.status, 200, '轻量端点不看关闭状态：进程还在就是还在')
    await entry.pool.stop()
})

