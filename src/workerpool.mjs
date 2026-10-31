// worker 池：分发器唯一认识的「外部世界」。
//
// #7 起它是默认服务（src/serve.mjs）的 worker 来源。
//
// 池子负责的事：拉起 worker、记住谁在忙、谁就绪、谁已经没了；不负责排队和等待预算
// （那归分发器），也不负责算签名（那归 worker）。
//
// 传输对象是注入的（spawn 返回一个有 send / on('message') / on('exit') / kill 的东西）：
// 生产用 child_process.fork，测试用内存里的假对象。真进程「什么时候报告完成」没法约时间，
// 而忙闲回收恰恰是必须被确定性验证的那部分。

import { EventEmitter } from 'node:events'
import { ERROR_KINDS } from './errors.mjs'
import { redactMachinePaths } from './log.mjs'
import { GIVE_UP_WINDOW_MS, backoffDelayMs, shouldGiveUp } from './dispatch.mjs'

/** 槽位没了（进程崩了 / 管道断了）：在飞的请求按「内部算错」收口，不能让调用方永远等。 */
export class WorkerLost extends Error {
    constructor(slotId) {
        super(`worker ${slotId} 在处理途中退出`)
        this.name = 'WorkerLost'
        this.kind = ERROR_KINDS.INTERNAL_ERROR
    }
}

export function createWorkerPool({
    workerCount,
    spawn,
    log = () => {},
    onGiveUp = () => {},
    respawnBaseMs = 1000,
    respawnCapMs = 60_000,
} = {}) {
    const events = new EventEmitter()
    const slots = []
    const timers = new Set()
    const exits = []
    let requests = 0
    let stopping = false
    let givenUp = false

    /** 一台进程绑回它的槽位：槽位号是稳定身份，重生换的是进程不是位置。 */
    function bind(slot) {
        const transport = spawn(slot.index)
        slot.transport = transport
        slot.ready = false
        slot.busy = false
        slot.blocker = null
        slot.dead = false
        slot.counted = false
        // 一台进程的死法会成对发来 exit / disconnect / error，而迟到的那一半可能在替补已经
        // 就绪之后才到。每个处理器都先对身份：不是当前这台传输的事件就当作没看见 ——
        // 否则旧进程迟到的 disconnect 会把正在服务流量的替补判死，还多记一次「反复退出」，
        // 攒够了就把整个服务掀掉。
        const mine = () => slot.transport === transport
        transport.on('message', message => {
            if (mine()) handleMessage(slot, message)
        })
        // child_process 的 'error'（spawn 失败、IPC 通道坏掉）没人接就是主进程的未捕获异常 ——
        // 这个 process 正是服务本身。而且它可能不带随后的 exit（比如 node 可执行文件本身
        // 找不到），所以也要计入「反复退出」，否则退避会永远卡在封顶反复试。
        transport.on('error', error => {
            if (!mine()) return
            log('worker-error', { id: slot.id, message: redactMachinePaths(String(error?.message || error)) })
            countExit(slot, null)
            gone(slot)
        })
        // 真进程死一次会来两个事件（disconnect 先、exit 随后）。回收与重生只认第一个，否则一个
        // 槽位会冒出两台进程；但「退出码」只有 exit 才知道，所以计数单独走 countExit ——
        // 拿 disconnect 的 null 当「非零退出」会把「5 次非零」悄悄变成「5 次任何退出」。
        transport.on('exit', code => {
            if (!mine()) return
            countExit(slot, code)
            gone(slot)
        })
        transport.on('disconnect', () => {
            if (mine()) gone(slot)
        })
        return transport
    }

    function gone(slot) {
        if (slot.dead) return
        slot.dead = true
        // 管道断了但进程还可能活着（比如它卡在原生调用里）。补一台之前先把这台关掉，
        // 否则每个事件都留下一个白占一份原生模块与内存的孤儿。
        // 真 exit 之后 kill 只是返回 false；关闭流程里由 stop 负责发 shutdown，这里不插手。
        if (!stopping) slot.transport.kill()
        reclaim(slot)
        slot.settle()
        scheduleRespawn(slot)
    }

    /** 一次进程死亡只计一次：exit 与 error 可能都到，也可能只到一个。 */
    function countExit(slot, code) {
        if (stopping || givenUp || slot.counted) return
        slot.counted = true
        if (code === 0) return
        log('worker-exit', { id: slot.id, code })
        const now = Date.now()
        // 只留窗口内那几次：这是一台要跑很多天的常驻进程，不能一直攒退出记录
        exits.push(now)
        while (exits.length > 0 && now - exits[0] > GIVE_UP_WINDOW_MS) exits.shift()
        if (!shouldGiveUp(exits, now, { windowMs: GIVE_UP_WINDOW_MS })) return
        givenUp = true
        // 已经排好的重生全部作废：继续重试只是把「机器坏了」拖成「谁都不知道坏了」
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        log('worker-giveup', { exits: exits.length, code })
        onGiveUp()
    }

    function scheduleRespawn(slot) {
        if (stopping || givenUp) return
        slot.failures += 1
        const delayMs = backoffDelayMs(slot.failures, { baseMs: respawnBaseMs, capMs: respawnCapMs })
        log('worker-respawn', { id: slot.id, delayMs, failures: slot.failures })
        const timer = setTimeout(() => {
            timers.delete(timer)
            if (stopping || givenUp) return
            bind(slot)
        }, delayMs)
        // 退避计时器不该把「本来该退出的进程」留在世上
        timer.unref()
        timers.add(timer)
    }

    function attach(index) {
        const slot = {
            id: `worker-${index}`,
            index,
            transport: null,
            ready: false,
            busy: false,
            dead: false,
            counted: false,
            pending: new Map(),
            failures: 0,
            blocker: null,
        }
        // 「这一台冷启动的事办完了没有」：就绪、预热失败、进程没了，三种都算完。
        // 没完就不拉下一台 —— 几台同时做 bdms.init 会把启动时间叠成一份更长的不可用窗口。
        slot.settled = new Promise(resolve => {
            slot.settle = resolve
        })
        slots.push(slot)
        try {
            bind(slot)
        } catch (error) {
            // spawn 同步抛错：槽位已经进了 slots，但手上没有 transport。标记为死，stop 才会跳过它，
            // 否则关池子会在一个没有通道的槽位上二次抛错，把调用方的原始错误盖掉。
            slot.dead = true
            slot.settle()
            try {
                slot.transport?.kill()
            } catch {
                /* 收尾失败不该盖住原始 spawn 错误 */
            }
            throw error
        }
        return slot
    }

    function handleMessage(slot, message) {
        if (!message || typeof message !== 'object') {
            log('worker-message-unknown', { id: slot.id, type: typeof message })
            return
        }
        if (message.type === 'ready') {
            slot.ready = true
            slot.blocker = null
            slot.failures = 0
            slot.settle()
            events.emit('available')
            return
        }
        if (message.type === 'warmup-failed') {
            // 保持未就绪、进程不退：这台不算进「能服务」，但别人还能干活
            slot.blocker = message.kind || ERROR_KINDS.INTERNAL_ERROR
            log('worker-warmup-failed', { id: slot.id, kind: slot.blocker, reason: message.reason })
            slot.settle()
            return
        }
        if (message.type === 'result') {
            const waiter = slot.pending.get(message.id)
            if (!waiter) return
            slot.pending.delete(message.id)
            slot.busy = false
            // message 一起带上：worker 那句「签名不完整：只拿到 N 个头」是排查时唯一能看到的东西
            waiter.resolve({ kind: message.kind, body: message.body, message: message.message })
            events.emit('available')
            return
        }
        log('worker-message-unknown', { id: slot.id, type: message.type })
    }

    function reclaim(slot) {
        slot.ready = false
        slot.busy = false
        for (const waiter of slot.pending.values()) waiter.reject(new WorkerLost(slot.id))
        slot.pending.clear()
    }

    return {
        get size() {
            return workerCount
        },
        get readyCount() {
            return slots.filter(slot => slot.ready).length
        },
        /** 在飞的签名数：黑盒用例靠它确认「真 worker 此刻正忙着」，才敢下手杀进程。 */
        get busyCount() {
            return slots.filter(slot => slot.busy).length
        },
        /**
         * 一台都不就绪时，「等一会儿会好」这句话还能不能说。
         *
         * 只有每台都明确报告「模块没加载 / 配置错」才认领 SIGNER_UNAVAILABLE（500，要人来修）；
         * 掺进任何一种「也许重生就好」的失败就退回 null，让分发器按服务忙（503）回。
         */
        get blocker() {
            if (slots.some(slot => slot.ready)) return null
            if (slots.length === 0) return null
            return slots.every(slot => slot.blocker === ERROR_KINDS.SIGNER_UNAVAILABLE)
                ? ERROR_KINDS.SIGNER_UNAVAILABLE
                : null
        },
        on(event, handler) {
            events.on(event, handler)
            return this
        },
        /** 拿走一个空闲且就绪的 worker；一个都没有就是 null，由分发器决定排队还是拒绝。 */
        lease() {
            const slot = slots.find(candidate => candidate.ready && !candidate.busy)
            if (!slot) return null
            slot.busy = true
            return {
                id: slot.id,
                run(request) {
                    // lease 与 run 之间一般没有事件循环，但通道坏了的时候这一道不算完：
                    // 真 send 失败可能是同步抛出，而抛出会逃出 drain()，把这条连接永远悬在忙
                    if (slot.dead) return Promise.reject(new WorkerLost(slot.id))
                    const id = `r${(requests += 1)}`
                    try {
                        slot.transport.send({ type: 'sign', id, request })
                    } catch (error) {
                        log('worker-send-failed', { id: slot.id, message: redactMachinePaths(String(error?.message || error)) })
                        gone(slot)
                        return Promise.reject(new WorkerLost(slot.id))
                    }
                    return new Promise((resolve, reject) => {
                        slot.pending.set(id, { resolve, reject })
                    })
                },
            }
        },
        /** 一台一台拉：前一台把冷启动的事做完（就绪 / 预热失败 / 没了）才动下一台。 */
        async start() {
            for (let index = 0; index < workerCount; index += 1) {
                // 关池子 / 整体放弃之后不能再补进程：新进程没人给它发 shutdown，会把主进程一起挂住。
                // stop() 只通知已经 attach 的槽位，所以检查必须放在每轮 attach 之前。
                if (stopping || givenUp) return
                await attach(index).settled
            }
        },
        async stop() {
            stopping = true
            for (const timer of timers) clearTimeout(timer)
            timers.clear()
            for (const slot of slots) {
                reclaim(slot)
                // 死在退避窗口里的槽位手上还是那个已关闭的通道：对它 send 不是返回 false 就完事，
                // Node 会在 process 上发一个 'error' 事件，把整个主进程掀掉。关池子时跳过。
                // 同步 spawn 失败的槽位没有通道，同样跳过。
                if (slot.dead || !slot.transport) continue
                try {
                    slot.transport.send({ type: 'shutdown' })
                } catch (error) {
                    // 通道在判死之前就坏了：关池子不该被它带崩，直接把这台收掉。
                    log('worker-send-failed', {
                        id: slot.id,
                        message: redactMachinePaths(String(error?.message || error)),
                    })
                    try {
                        slot.transport.kill()
                    } catch {
                        /* 收尾失败不再往上抛：stop 的调用方正要处理更重要的原始错误 */
                    }
                }
            }
        },
    }
}
