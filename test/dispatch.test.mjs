// 分发器的决策全是纯函数：当前时刻从参数进来，定时器只负责「用现在这个时间去调一下」。
// 因此这些判据不需要接缝、不需要假时钟，构造几组时刻就能把边界钉死。

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { Queue, backoffDelayMs, deriveWorkerCount, shouldGiveUp, shouldReject } = await import('../src/dispatch.mjs')

test('等待预算：正好花完就拒，差几毫秒继续等，超出必拒', () => {
    // 预算 5000ms，入队时刻 1000 → deadline 6000
    assert.equal(shouldReject(1000, 5999, 5000), false, '还差 1ms，继续排队')
    assert.equal(shouldReject(1000, 6000, 5000), true, '正好等于预算：已经没有额度了')
    assert.equal(shouldReject(1000, 6003, 5000), true, '超出预算')
    assert.equal(shouldReject(1000, 1000, 5000), false, '刚入队')
})

test('队列先进先出，满了直接拒而不是无限堆积', () => {
    const queue = new Queue(2)
    assert.equal(queue.depth, 0)

    assert.equal(queue.push('a'), true)
    assert.equal(queue.push('b'), true)
    assert.equal(queue.push('c'), false, '超出上限：立刻拒绝，不占额度')
    assert.equal(queue.depth, 2)

    assert.equal(queue.shift(), 'a', '先来先服务')
    assert.equal(queue.push('c'), true, '腾出一个位置就能再进一个')
    assert.deepEqual([...queue], ['b', 'c'], '快照顺序就是出队顺序')

    assert.equal(queue.shift(), 'b')
    assert.equal(queue.shift(), 'c')
    assert.equal(queue.depth, 0)
    assert.equal(queue.shift(), undefined, '排空之后再取还是空')

    // 客户端挂断时按身份把它那一项挪走，位置要立刻还给下一个等待者
    const occupied = new Queue(1)
    assert.equal(occupied.push({ id: 'gone' }), true)
    assert.equal(occupied.push({ id: 'next' }), false, '位置被占着')
    assert.equal(occupied.remove(occupied.peek()), true)
    assert.equal(occupied.depth, 0)
    assert.equal(occupied.push({ id: 'next' }), true, '腾出来的位置马上能用')
    assert.equal(occupied.remove({ id: '早就不在队列里' }), false, '不在队列里就是没挪动')
})

test('worker 数按绑定地址推导：只服务本机就不多开，对局域网开放才按核数扩', () => {
    // 环境变量永远优先，且日志要说清「这个数是这么来的」
    assert.deepEqual(deriveWorkerCount({ override: '6', bind: '127.0.0.1', parallelism: 8 }), {
        count: 6,
        reason: 'LIBMSSDK_WORKERS=6',
    })
    // 绑定回环：单机自用，多开只是白吃内存和更长的启动。127/8 整段都算回环。
    for (const bind of ['127.0.0.1', '127.0.0.2', '127.1.2.3', 'localhost', '::1', '[::1]']) {
        assert.deepEqual(deriveWorkerCount({ bind, parallelism: 8 }), {
            count: 1,
            reason: `绑定 ${bind} 是回环地址，本机自用开 1 个`,
        })
    }
    // 非回环：物理核按 availableParallelism 除以 2 估算，取它的 75%
    assert.deepEqual(deriveWorkerCount({ bind: '0.0.0.0', parallelism: 8 }), {
        count: 3,
        reason: '绑定 0.0.0.0 对局域网开放，按约 4 个物理核的 75% 开 3 个',
    })
    assert.equal(deriveWorkerCount({ bind: '192.168.1.10', parallelism: 16 }).count, 6)
    assert.equal(deriveWorkerCount({ bind: '192.168.1.10', parallelism: 2 }).count, 1, '再小也不开 0 个')
    assert.equal(deriveWorkerCount({ bind: '192.168.1.10', parallelism: 1 }).count, 1)
    // 覆盖值非法就退回推导：0 个 worker 等于把服务关掉
    assert.equal(deriveWorkerCount({ override: '0', bind: '127.0.0.1', parallelism: 8 }).count, 1)
    assert.equal(deriveWorkerCount({ override: 'abc', bind: '192.168.1.10', parallelism: 8 }).count, 3)
})

test('worker 重生退避：1 秒起指数翻倍，封顶 60 秒', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(n => backoffDelayMs(n)), [1000, 2000, 4000, 8000, 16000])
    assert.equal(backoffDelayMs(20), 60_000, '翻倍到顶就停，别把延迟算成天文数字')
    assert.equal(backoffDelayMs(0), 0, '没失败过就不等')
})

test('短时间退出过多就整体退出，交给外层重启策略', () => {
    const exits = [10_000, 20_000, 30_000, 40_000]
    // 60 秒窗口内数到 5 次非零退出就不再自己重试
    assert.equal(shouldGiveUp(exits, 50_000), false, '4 次还撑得住')
    assert.equal(shouldGiveUp([...exits, 50_000], 50_000), true, '第 5 次落进窗口')
    // 最早那次已经滑出窗口：说明这台机器是「偶发」而不是「反复」
    assert.equal(shouldGiveUp([...exits, 75_000], 75_000), false, '窗口里只剩 4 次')
    assert.equal(shouldGiveUp([], 75_000), false)
})
