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

const { createEndpointsHandler, DEPRECATED_AT, DEPRECATION_HTTP_VALUE, SUNSET_HTTP_DATE } = await import('../src/endpoints.mjs')
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
    const server = http.createServer(createEndpointsHandler({ config, ...options }))
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

test('GET /readyz：有就绪 worker 才 200，零 worker 或正在关闭时 503；/healthz 是它的别名', async () => {
    let ready = false
    let closing = false
    const { baseUrl } = await serveHandler({ readiness: () => ready && !closing })

    const warming = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(warming.status, 503, '预热未完成时不能让编排器以为已就绪')
    const warmingPayload = await warming.json()
    assert.equal(warmingPayload.ready, false)
    // 别名必须是同一份答案：老编排配置不改也还能用
    const legacyWarming = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(legacyWarming.status, 503, '/healthz 未就绪时与 /readyz 同口')
    assert.deepEqual(await legacyWarming.json(), warmingPayload)

    ready = true
    const serving = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(serving.status, 200)
    const servingPayload = await serving.json()
    assert.equal(servingPayload.ready, true)
    const legacy = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(legacy.status, 200)
    assert.deepEqual(await legacy.json(), servingPayload)

    closing = true
    const shutting = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) })
    assert.equal(shutting.status, 503, '已经在收尾了就不该再被当成能服务')
    assert.equal((await shutting.json()).ready, false)

    // 尾斜杠算同一条路由：代理与手敲的 curl 常带上它
    assert.equal((await fetch(`${baseUrl}/readyz/`, { signal: AbortSignal.timeout(5000) })).status, 503)
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
        fallback: createEndpointsHandler({ config, readiness: () => pool.readyCount > 0 }),
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
            assert.equal(response.headers.get('deprecation'), DEPRECATION_HTTP_VALUE, `${path}：要带弃用信号`)
            assert.equal(response.headers.get('sunset'), SUNSET_HTTP_DATE, `${path}：要带到场时间`)
            const payload = await response.json()
            assert.equal(payload.ok, false)
            assert.equal(payload.code, 'endpoint_removed', '稳定原因码，不是裸的 not_found')
            assert.match(payload.replacement, replacement, `${path}：回包里要写明替代做法`)
            // 两个时刻在体里也各写一份（同 Retry-After 的规矩），但写的是日期本身，
            // 不是头里那个 `@<秒>` 的编码 —— 读 body 的人不该被迫懂 Structured Field 的语法
            assert.equal(payload.deprecated_at, DEPRECATED_AT, `${path}：体里也要有弃用时刻`)
            assert.equal(payload.sunset, SUNSET_HTTP_DATE, `${path}：体里也要有到期时刻`)
            assert.equal(payload.error.includes('sessionid_ss'), false, '调用方发来的 Cookie 不回显')
            assert.equal(response.headers.get('retry-after'), null, '改用命令行没有「再等一秒」这一说')
        }
        // 上面这些请求一个 Authorization 都没带，而 config.token 是设着的：回执属于
        // 「这条路由没有了」这一类回答（通用 404 今天也不看凭据），不是免鉴权的能力入口。
        // 能力（签名、打上游）都已经不在这条路上了 —— AGENTS.md 的鉴权约定写明了这个边界。
        // 认得这条路就行，不看方法；尾斜杠也算同一条：拿 GET 或带斜杠敲旧端点的人要看懂发生了什么
        for (const probe of ['/probe', '/probe/', '/track/stream/']) {
            const receipt = await originalFetch(`${baseUrl}${probe}`, { signal: AbortSignal.timeout(5000) })
            assert.equal(receipt.status, 404, `${probe}：不给凭据也回得懂`)
            assert.equal(receipt.headers.get('deprecation'), DEPRECATION_HTTP_VALUE, `${probe}：带弃用信号`)
            assert.equal(receipt.headers.get('sunset'), SUNSET_HTTP_DATE, `${probe}：带到场时间`)
        }
    } finally {
        globalThis.fetch = originalFetch
    }
    assert.deepEqual(upstreamCalls, [], 'HTTP 层不再有任何向上游发请求的路径')
})

test('GET /config 已删除：404 但说清替代做法，且不配到期信号（它没有弃用期）', async () => {
    const { baseUrl } = await serveHandler({ readiness: () => true })
    const response = await fetch(`${baseUrl}/config`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 404, '/config 不再提供')
    assert.equal(response.headers.get('deprecation'), null, '本次就删掉了，不是「将要删除」')
    assert.equal(response.headers.get('sunset'), null)
    const payload = await response.json()
    assert.equal(payload.code, 'endpoint_removed', '不是裸的 not_found：#1 用户故事 24 要的是看得懂的删除')
    assert.match(payload.replacement, /node src\/index\.mjs config/)
    assert.equal(payload.sunset, undefined, '没有弃用期的删除不编造到期时间')

    // 没听过的路径仍是那句通用 404
    const unknown = await fetch(`${baseUrl}/never-heard-of-it`, { signal: AbortSignal.timeout(5000) })
    assert.equal(unknown.status, 404)
    assert.match(await unknown.text(), /"code":"not_found"/)
    assert.equal(unknown.headers.get('deprecation'), null)
})

// AGENTS.md 的鉴权约定写着「设了 Token 后所有 POST 都要 Bearer」，不看凭据的回答只有三类：
// 探针、已删端点的回执（上一组用例）、通用 404。这里把例外钉在用例上，免得它变成无意中的洞。
test('健康探针不看凭据：POST 也一样答，回包里一个 Token 字节都没有', async () => {
    const { baseUrl } = await serveHandler({ readiness: () => true })
    const viaPost = await fetch(`${baseUrl}/livez`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    assert.equal(viaPost.status, 200, '设了 Token 也不挡探针：它回答的是「进程在不在」')
    assert.deepEqual(await viaPost.json(), { ok: true, service: 'libmssdk', version: config.version })

    const readyViaPost = await fetch(`${baseUrl}/readyz`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    assert.equal(readyViaPost.status, 200)
    assert.equal(JSON.stringify(await readyViaPost.json()).includes(config.token), false, 'Token 不该出现在任何探针回包里')
})

// 两个头是配对的常量，写坏了中间件会整条忽略：日期必须能被重新格式化回原样（星期、月份、
// 补零都算），而且 RFC 9745 要求 Sunset 不早于 Deprecation。
// 两个日期各写一份的话，就必须互相自洽：头里的 @<秒> 要等于日期本身，Sunset 不得早于弃用起始
// （RFC 9745）。写错星期或月份都会在这里翻脸，因为 Date 会把它重新格式化回原样才算通过。
test('弃用与到期的日期常量自洽，头与体说的是同一个时刻', () => {
    for (const label of ['deprecated_at', 'sunset']) {
        const value = label === 'deprecated_at' ? DEPRECATED_AT : SUNSET_HTTP_DATE
        assert.equal(new Date(value).toUTCString(), value, `${label} 不是合法的 HTTP-date`)
    }
    assert.equal(DEPRECATION_HTTP_VALUE, '@1793404800', 'Deprecation 的头编码与弃用日期不是同一时刻')
    assert.ok(Date.parse(SUNSET_HTTP_DATE) >= Date.parse(DEPRECATED_AT), 'Sunset 不能早于 Deprecation（RFC 9745）')
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
// 挡不住下一个人新加一条。文件表用目录扫出来，新增的 src/*.mjs 自动在守卫范围内。
test('出网只此一处：src 里除 probe.mjs 外没人向上游发请求', () => {
    // 递归扫：src 下将来开出子目录也自动在范围内，别留一条「放进子目录就查不到」的缝
    const root = path.join(here, '..', 'src')
    const sources = fs
        .readdirSync(root, { recursive: true })
        .filter(entry => typeof entry === 'string' && entry.endsWith('.mjs'))
        .map(entry => [entry, fs.readFileSync(path.join(root, entry), 'utf8')])
    assert.ok(sources.length > 10, `扫到的 src 模块数不对（${sources.length}），守卫可能已经失效`)
    for (const [name, source] of sources) {
        if (path.basename(name) === 'probe.mjs') continue
        // fetch / http.request / https.request：出网的三种写法都堵掉
        assert.equal(
            /\bfetch\(|\bhttps?\.(?:request|get)\(/.test(source),
            false,
            `src/${name} 不该向上游发请求：出网只许在 src/probe.mjs`,
        )
        // index.mjs 是命令行入口，它就是那个唯一合法的引用方；其余模块连引用都不该有 ——
        // 留了 import，下一个人就知道怎么往 HTTP 层加路由
        if (name === 'index.mjs') continue
        assert.equal(/probe\.mjs/.test(source), false, `src/${name} 不该引用 src/probe.mjs`)
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
