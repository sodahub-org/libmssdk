// 池子是这一票唯一新增的接缝：分发器不认识进程，只认识「现在拿得到空闲 worker 吗」。
// 所以这些用例走池子的公开接口，传输用内存里的假对象 —— 真 fork 的进程归黑盒用例。

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { createWorkerPool } = await import('../src/workerpool.mjs')
const { FakeWorker } = await import('./helpers/fake-worker.mjs')

/** 让事件跑一轮：池子的状态机就是靠这些节点落位的。 */
const tick = () => new Promise(resolve => setImmediate(resolve))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(condition, describe) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (condition()) return
        await delay(1)
    }
    throw new Error(`等不到：${describe}`)
}

const healthy = (count, options = {}) => {
    const { respawnBaseMs = 1, respawnCapMs = 2, onGiveUp = () => {}, autoReady = true } = options
    const workers = []
    const spawnOrder = []
    const notes = []
    const pool = createWorkerPool({
        workerCount: count,
        respawnBaseMs,
        respawnCapMs,
        log: (event, detail) => notes.push({ event, detail }),
        onGiveUp,
        spawn: index => {
            const worker = new FakeWorker(index)
            workers.push(worker)
            spawnOrder.push(worker.id)
            if (autoReady) setImmediate(() => worker.reportReady())
            return worker
        },
    })
    // 同一个槽位重生后会再来一台假 worker（槽位号不变），所以取最后那台 = 当前活着的那台
    const byId = id => workers.findLast(worker => worker.id === id)
    return { pool, workers, spawnOrder, byId, notes }
}

const job = { url: 'https://api.qishui.com/luna/pc/track_v2?a=1', headers: {}, deviceId: '7000000000000001' }

test('关池子时不再补进程：start 等在上一台时 stop，后面的槽位不 spawn', async () => {
    const workers = []
    const spawnOrder = []
    const pool = createWorkerPool({
        workerCount: 3,
        // 不自动就绪：start 会一直停在第一台的 settled 上，给 stop 留出插进来的窗口
        spawn: index => {
            const worker = new FakeWorker(index)
            workers.push(worker)
            spawnOrder.push(index)
            return worker
        },
        log: () => {},
    })

    const starting = pool.start()
    await waitFor(() => spawnOrder.length === 1, '第一台已经拉起')
    await pool.stop()
    workers[0].exit(0)
    await starting

    assert.deepEqual(spawnOrder, [0], 'stop 之后不该再拉起第二、第三台')
})

test('分发只发给空闲 worker：报告完成之前不回池', async () => {
    const { pool, byId } = healthy(2)
    await pool.start()
    assert.equal(pool.readyCount, 2)

    const a = pool.lease()
    const b = pool.lease()
    assert.ok(a && b, '两个就绪就该拿到两个槽位')
    assert.notEqual(a.id, b.id, '同一个 worker 不能同时接两件事')

    const aDone = a.run(job)
    const bDone = b.run(job)
    assert.equal(pool.lease(), null, '两个都在飞：没有空闲槽位')

    byId(a.id).reportResult()
    const outcome = await aDone
    assert.equal(outcome.kind, 'SUCCESS')
    assert.equal(outcome.body.url, job.url, '回的就是这一次请求算出来的东西')

    const reused = pool.lease()
    assert.equal(reused.id, a.id, 'worker 报告完成之后才重新回到空闲池')
    assert.equal(pool.lease(), null, 'b 还在飞，不能再拿走一个')

    const reusedDone = reused.run(job)
    byId(b.id).reportResult()
    byId(a.id).reportResult()
    await Promise.all([bDone, reusedDone])
    await pool.stop()
})

test('worker 崩了：在飞的请求被清理，槽位不会永久停在忙', async () => {
    const { pool, byId } = healthy(2)
    await pool.start()

    const a = pool.lease()
    const inFlight = a.run(job)
    byId(a.id).exit(1)

    const error = await inFlight.catch(reason => reason)
    assert.equal(error?.kind, 'INTERNAL_ERROR', '按「内部算错」收口，让分发器回 500 而不是让调用方永远等')

    // a 已经不算就绪，但 b 的空位不能被 a 的死拖住
    const survivor = pool.lease()
    assert.equal(survivor.id, 'worker-1', '崩掉的那台不再被派发')
    assert.equal(pool.readyCount, 1)
    survivor.run(job)
    byId('worker-1').reportResult()
    await pool.stop()
})

test('worker 退出后按指数退避重生，重生完继续能服务', async () => {
    const { pool, workers, spawnOrder, byId, notes } = healthy(1, { autoReady: true, respawnBaseMs: 30, respawnCapMs: 30 })
    await pool.start()

    workers[0].exit(1)
    assert.equal(pool.readyCount, 0, '没了就是没了，不能还挂着就绪')
    // 不靠「跑一个 tick 看它还没重生」来证明等待存在：机器一忙，一个 30ms 的计时器
    // 完全可能比这一拍先跑完（并行跑整包时就这么翻过一次脸）。直接看池子自己宣布的时长。
    const planned = notes.find(note => note.event === 'worker-respawn')
    assert.equal(planned.detail.delayMs, 30, '重生要等满退避窗口，不是立刻')

    await waitFor(() => spawnOrder.length === 2, '退避之后该重生')
    await waitFor(() => pool.readyCount === 1, '重生后要重新预热到就绪')

    const slot = pool.lease()
    const done = slot.run(job)
    byId(slot.id).reportResult()
    assert.equal((await done).body.url, job.url, '重生出来的那台要能接着算')
    await pool.stop()
})

test('反复退出就把等待时间翻倍，而不是每次隔同样的时间重试', async () => {
    const { pool, workers, spawnOrder, notes } = healthy(1, { autoReady: false, respawnBaseMs: 5, respawnCapMs: 60 })
    const starting = pool.start()
    workers[0].reportReady()
    await starting

    // 每台重生出来的都没就绪过就又退出：失败次数累计，退避跟着翻倍
    for (let index = 0; index < 3; index += 1) {
        workers.at(-1).exit(1)
        // 重生排在 setTimeout 里，同一个 tick 内绝不可能已经拉起来：这条不需要靠 sleep 去赶
        assert.equal(spawnOrder.length, index + 1, '退避没到就重生，等于让坏掉的机器一直占着 CPU')
        await waitFor(() => spawnOrder.length === index + 2, `第 ${index + 1} 次重生`)
    }
    const delays = notes.filter(note => note.event === 'worker-respawn').map(note => note.detail.delayMs)
    assert.deepEqual(delays, [5, 10, 20], '1 秒起翻倍的节奏（这里用毫秒测试），封顶由 backoffDelayMs 管')
    await pool.stop()
})

test('60 秒里退出 5 次就整体退出，交给外层重启策略', async () => {
    let giveUps = 0
    const { pool, workers, spawnOrder } = healthy(1, {
        autoReady: false,
        respawnBaseMs: 1,
        respawnCapMs: 1,
        onGiveUp: () => {
            giveUps += 1
        },
    })
    const starting = pool.start()
    workers[0].reportReady()
    await starting

    for (let index = 0; index < 5; index += 1) {
        workers.at(-1).exit(1)
        await waitFor(() => spawnOrder.length === index + 2 || giveUps > 0, `第 ${index + 1} 次重生`)
    }
    assert.equal(giveUps, 1, '只叫一次：主进程整体退出，不再自己无限重试')

    // 放弃时已经排好的重生计时器全部作废，所以这里不需要等一看就能断定「不再拉新的」：
    // 初始 1 台 + 前 4 次退出各重生 1 台，第 5 次只触发放弃
    assert.equal(spawnOrder.length, 5, '放弃之后一台都不再拉')
    await pool.stop()
})

test('拉起 worker 时等前一个就绪再拉下一个：冷启动不能挤在一起', async () => {
    const { pool, workers, spawnOrder } = healthy(3, { autoReady: false })
    const starting = pool.start()

    await tick()
    assert.deepEqual(spawnOrder, ['worker-0'], '第一个还没报就绪，第二个不许动')

    workers[0].reportReady()
    await tick()
    assert.deepEqual(spawnOrder, ['worker-0', 'worker-1'], '等前一个就绪才拉下一个')

    workers[1].reportReady()
    await tick()
    assert.deepEqual(spawnOrder, ['worker-0', 'worker-1', 'worker-2'])
    workers[2].reportReady()
    await starting
    assert.equal(pool.readyCount, 3)
    assert.equal(pool.size, 3, '池子不自作主张改数量：数量是分发前算好的')
    await pool.stop()
})

test('单个 worker 预热失败：它保持未就绪，但进程不退出', async () => {
    const { pool, workers } = healthy(2, { autoReady: false })
    const starting = pool.start()

    workers[0].report({ type: 'warmup-failed', budgetMs: 30_000 })
    await tick()
    assert.equal(pool.readyCount, 0, '预热没过去就是没就绪，不能假装能服务')
    // 还是这两台：预热失败既没把进程判死，也没提前拉出替补（下一台是等它把话说完才拉的）
    assert.equal(workers.length, 2)

    workers[1].reportReady()
    await starting
    const slot = pool.lease()
    assert.equal(slot.id, 'worker-1', '只有所有 worker 都不就绪才整体拒绝流量')
    assert.equal(pool.readyCount, 1)
    await pool.stop()
})

test('未知消息落到默认分支：不改忙闲、不退出、也不假装完成', async () => {
    const { pool, workers, notes } = healthy(1)
    await pool.start()

    const slot = pool.lease()
    const done = slot.run(job)
    workers[0].report({ type: 'chatter' })
    workers[0].report('一个字符串')
    workers[0].report({ type: 'result', id: '没有这个 id', kind: 'SUCCESS' })
    await tick()
    assert.equal(pool.readyCount, 1, '看不懂的东西不算崩')
    assert.equal(pool.lease(), null, '也不能把在飞的槽位当成腾出来了')
    assert.equal(notes.filter(note => note.event === 'worker-message-unknown').length, 2)

    workers[0].reportResult()
    assert.equal((await done).kind, 'SUCCESS', '真正的完成才结清这一次')
    await pool.stop()
})

test('全部 worker 都是「模块没加载 / 配置错」时，报的是 SIGNER_UNAVAILABLE 而不是「再等等」', async () => {
    const { pool, workers } = healthy(2, { autoReady: false })
    const starting = pool.start()
    for (const reason of ['bdms.node 没配置或文件不存在', '身份文件里没有可读的设备号']) {
        workers.at(-1).report({ type: 'warmup-failed', kind: 'SIGNER_UNAVAILABLE', reason })
        await tick()
    }
    await starting

    assert.equal(pool.readyCount, 0)
    assert.equal(pool.blocker, 'SIGNER_UNAVAILABLE', '这种情况等多久都不会好，不能挂成 503')
    await pool.stop()
})

test('只要还可能自己好起来，就不冒充「机器坏了」：blocker 让位给 503', async () => {
    const { pool, workers } = healthy(2, { autoReady: false })
    const starting = pool.start()
    workers[0].report({ type: 'warmup-failed', kind: 'SIGNER_UNAVAILABLE', reason: 'bdms.node 没配置' })
    await tick()
    workers[1].report({ type: 'warmup-failed', kind: 'INTERNAL_ERROR', budgetMs: 30_000 })
    await starting

    assert.equal(pool.readyCount, 0)
    assert.equal(pool.blocker, null, '混着一种「也许重生就好」的失败，就按服务忙回')
    await pool.stop()
})

test('worker 的失败原因原样交回分发器：真池子不能比假池子少带一个字段', async () => {
    const { pool, byId } = healthy(1)
    await pool.start()

    const slot = pool.lease()
    const done = slot.run(job)
    byId(slot.id).reportFailure('INTERNAL_ERROR', '签名不完整：只拿到 0 个头')

    const outcome = await done
    assert.equal(outcome.kind, 'INTERNAL_ERROR')
    assert.equal(outcome.message, '签名不完整：只拿到 0 个头', '这句是排查时唯一能看到的东西，不能在半路丢掉')
    await pool.stop()
})

test('退避途中关池子：不再对已经没了的通道 send', async () => {
    // 重生要等 50ms，所以 stop 落在「进程已死、新进程还没拉起来」那个窗口里
    const { pool, workers } = healthy(2, { autoReady: true, respawnBaseMs: 50 })
    await pool.start()

    const dead = workers[0]
    dead.exit(1)
    await pool.stop()

    assert.equal(
        dead.sent.some(message => message.type === 'shutdown'),
        false,
        '对已关闭的 IPC 通道 send 会变成 process 的 error 事件，把整个主进程掀掉',
    )
    assert.ok(
        workers.some(worker => worker.sent.some(message => message.type === 'shutdown')),
        '活着的那台要收到关闭指令，不能因为跳过死的就谁都跳过',
    )
})

test('spawn 同步抛错：start 失败后 stop 仍能安全收尾，不再二次抛错', async () => {
    const pool = createWorkerPool({
        workerCount: 1,
        spawn: () => {
            throw new Error('spawn boom')
        },
        log: () => {},
    })

    const startError = await pool.start().catch(error => error)
    assert.match(startError.message, /spawn boom/, 'start 要保留原始 spawn 错误')
    await pool.stop()
    assert.equal(pool.readyCount, 0)
})

test('重生时 spawn 同步抛错也不掀掉主进程：按失败继续退避直到放弃', async () => {
    let spawns = 0
    let giveUps = 0
    const workers = []
    const pool = createWorkerPool({
        workerCount: 1,
        respawnBaseMs: 1,
        respawnCapMs: 1,
        log: () => {},
        onGiveUp: () => {
            giveUps += 1
        },
        spawn: index => {
            spawns += 1
            if (spawns === 1) {
                const worker = new FakeWorker(index)
                workers.push(worker)
                setImmediate(() => worker.reportReady())
                return worker
            }
            throw new Error('respawn boom')
        },
    })
    await pool.start()
    workers[0].exit(1)

    await waitFor(() => giveUps === 1, '连续 spawn 失败攒够次数后整体放弃')
    await pool.stop()
    assert.equal(pool.readyCount, 0)
})

test('关池子时通道已经坏了：send 抛错不能把 stop 带崩', async () => {
    const { pool, workers } = healthy(1)
    await pool.start()
    // 不触发 exit：槽位还被认为是活的，但通道已经关闭（模拟通道比 exit 先坏）
    workers[0].exited = true

    await pool.stop()
    assert.ok(workers[0].killed.length > 0, '坏通道的那台要被直接收掉')
})

test('干净的 exit(0) 不算进「反复退出」：判据数的是非零退出', async () => {
    let giveUps = 0
    const { pool, workers, spawnOrder } = healthy(1, {
        autoReady: false,
        respawnBaseMs: 1,
        respawnCapMs: 1,
        onGiveUp: () => {
            giveUps += 1
        },
    })
    const starting = pool.start()
    workers[0].reportReady()
    await starting

    for (let index = 0; index < 5; index += 1) {
        workers.at(-1).exit(0)
        await waitFor(() => spawnOrder.length === index + 2, `第 ${index + 1} 次重生`)
    }
    assert.equal(giveUps, 0, '五次都是干净退出：这台机器没坏，只是进程自己走了')
    workers.at(-1).reportReady()
    assert.ok(pool.lease(), '重生出来的那台照常就绪待命')
    await pool.stop()
})

test('只来 error 不来 exit 的死亡也计入反复退出：不然退避会永远卡在封顶重试', async () => {
    let giveUps = 0
    const { pool, workers, spawnOrder } = healthy(1, {
        autoReady: false,
        respawnBaseMs: 1,
        respawnCapMs: 1,
        onGiveUp: () => {
            giveUps += 1
        },
    })
    const starting = pool.start()
    workers[0].reportReady()
    await starting

    for (let index = 0; index < 5; index += 1) {
        workers.at(-1).fail(new Error('spawn node ENOENT'))
        await waitFor(() => spawnOrder.length === index + 2 || giveUps > 0, `第 ${index + 1} 次重生`)
    }
    assert.equal(giveUps, 1, '计数不能只挂在 exit 上：spawn 失败的进程根本走不到 exit')
    assert.equal(spawnOrder.length, 5, '放弃之后不再拉新的')
    await pool.stop()
})

test('管道断了但进程还在：补一台之前先把这台关掉，别留白占原生模块的孤儿', async () => {
    const { pool, workers, spawnOrder } = healthy(1, { autoReady: true, respawnBaseMs: 5 })
    await pool.start()

    // 只来 disconnect，没有 exit —— 真进程「卡在原生调用里把通道弄断」就是这个形状
    workers[0].emit('disconnect')
    assert.deepEqual(workers[0].killed, [undefined], '断开的那台要被关掉')
    await waitFor(() => spawnOrder.length === 2, '再补一台')
    await waitFor(() => pool.readyCount === 1, '补上来的那台预热到就绪')
    assert.equal(workers.length, 2, '补上来的是新进程，不是那台孤儿')
    await pool.stop()
})

test('旧进程迟到的事件不能杀掉替补：一台进程的事件只认它自己那台传输', async () => {
    const { pool, workers, spawnOrder, notes } = healthy(1, { autoReady: true, respawnBaseMs: 1 })
    await pool.start()

    const old = workers[0]
    old.exit(1)
    await waitFor(() => spawnOrder.length === 2 && pool.readyCount === 1, '替补起来并就绪')
    const replacement = workers.at(-1)

    // 真进程死一次会成对发来 exit / disconnect / error；迟到的一半落在替补已经就绪之后
    old.emit('disconnect')
    old.fail(new Error('IPC 通道已关闭'))
    await tick()

    assert.equal(pool.readyCount, 1, '替补不能被旧进程迟到的事件判死')
    assert.deepEqual(replacement.killed, [], '替补没被关掉 —— 关掉它等于把一条正常服务的路径掀了')
    assert.equal(
        notes.filter(note => note.event === 'worker-exit').length,
        1,
        '迟到的事件不该再记一次退出：攒够了会把好端端的进程判成「机器坏了」',
    )
    await pool.stop()
})

test('派出去的 send 当场抛了也不把槽位悬在忙：按这台没了处理', async () => {
    const { pool, workers } = healthy(1)
    await pool.start()

    const slot = pool.lease()
    const dead = workers.at(-1)
    dead.exited = true // 通道已经关了：真 child_process 这时 send 会抛，而不是返回 false
    const outcome = await slot.run(job).catch(reason => reason)

    assert.equal(outcome?.kind, 'INTERNAL_ERROR', '调用方拿到错误分类，不是永远等')
    assert.equal(pool.readyCount, 0, '这台按没了处理，不再挂着就绪')
    assert.equal(pool.busyCount, 0, '槽位没有被悬住在忙')
    await pool.stop()
})
