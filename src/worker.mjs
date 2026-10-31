#!/usr/bin/env node
// worker：不监听端口、不解析 HTTP，只做「拿一份请求 → 调原生模块 → 把响应字节交回去」。
//
// 为什么要单独一个进程：一次签名要阻塞一百到几百毫秒并且吃满一个核，期间这个进程什么都不能做。
// 把它隔离出去，主进程的事件循环才一直是空的 —— 只有它空着，才能计时、才能在超预算时回那个 503。
//
// 身份：worker 只读身份文件（readStoredIdentity），这条路径上没有创建。多进程首次启动不该分裂
// 出两个设备号，那是主进程 fork 之前用独占创建收敛好的事（见 src/identity.mjs）。

import path from 'node:path'
import { BdmsSigner } from './bdms.mjs'
import { resolveBdmsModule } from './config.mjs'
import { parsePositiveInt } from './dispatch.mjs'
import { signResponse } from './contract.mjs'
import { ERROR_KINDS } from './errors.mjs'
import { readStoredIdentity } from './identity.mjs'
import { redactMachinePaths } from './log.mjs'
import { settleWarmup } from './warmup.mjs'

const env = key => (process.env[key] || '').trim()

/** worker 侧的设备身份：环境变量钉死 > 身份文件里那一份。读不到就是没有，绝不代替主进程去建。 */
function workerIdentity() {
    const pinned = env('LIBMSSDK_DEVICE_ID') || env('QISHUI_DEVICE_ID')
    if (pinned) return { deviceId: pinned, iid: '', fp: pinned }
    const stored = readStoredIdentity()
    return {
        deviceId: stored?.device_id || '',
        iid: stored?.iid || '',
        fp: stored?.fp || stored?.device_id || '',
    }
}

/**
 * 预热探针：每次都用同一份输入。
 *
 * 只有输入固定，「这一轮输出和上一轮一样长吗」才只反映原生模块自己的状态；探针里放随机数
 * （比如官方那个 trace_id）会把噪声读成「还没稳」。
 */
function warmupProbe(deviceId) {
    return {
        url: `https://api.qishui.com/luna/pc/track_v2?aid=386088&app_name=luna_pc&device_id=${deviceId}&fp=${deviceId}`,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'user-agent': 'LunaPC/warmup',
        },
        deviceId,
    }
}

function send(message) {
    if (!process.send) return
    process.send(message)
}

/** 报错文本要能进日志也能回给调用方，所以先过一遍本机路径脱敏，再截断。 */
function mask(text, modulePath) {
    return redactMachinePaths(String(text || '未知错误'), [modulePath, path.dirname(modulePath)]).slice(0, 200)
}

function describeError(error, modulePath) {
    return mask(String(error?.message || error), modulePath)
}

/** 算一次签名并把响应字节交回去。就绪判据与采样循环在 src/warmup.mjs。 */
function handleTask(signer, message) {
    const request = message.request || {}
    const startedAt = Date.now()
    try {
        const signed = signer.sign({
            url: request.url,
            headers: request.headers || {},
            deviceId: request.deviceId || '',
        })
        send({
            type: 'result',
            id: message.id,
            kind: ERROR_KINDS.SUCCESS,
            // elapsed_ms 是这一次计算的耗时：契约里这个字段本来就说的是算签名花了多久
            body: signResponse({ ...signed, elapsedMs: Date.now() - startedAt }),
        })
    } catch (error) {
        // 这里只可能是「模块算完了但东西不对」（缺 X-Helios / 抛异常）：按内部算错收口。
        // 请求合法性在主进程就判过了，配置错在启动时就报过了，两条路都不到这里。
        send({
            type: 'result',
            id: message.id,
            kind: ERROR_KINDS.INTERNAL_ERROR,
            message: describeError(error, signer.modulePath),
        })
    }
}

function main() {
    const identity = workerIdentity()
    const modulePath = resolveBdmsModule()
    const signer = new BdmsSigner({ modulePath, deviceId: identity.deviceId })

    // 起不来的原因先说清楚，别让「配置错了」被分发器读成「还在预热，等等就好」。
    const blockers = []
    if (!signer.available) blockers.push('bdms.node 没配置或文件不存在')
    if (!identity.deviceId) blockers.push('身份文件里没有可读的设备号')
    if (blockers.length === 0) {
        try {
            signer.load()
        } catch (error) {
            blockers.push(describeError(error, modulePath))
        }
    }
    if (blockers.length > 0) {
        send({ type: 'warmup-failed', kind: ERROR_KINDS.SIGNER_UNAVAILABLE, reason: blockers.join('；') })
        // 进程不退：这台不算进「能服务」，别的 worker 照常干活。
    } else {
        const budgetMs = parsePositiveInt(env('LIBMSSDK_WARMUP_BUDGET_MS'), 30_000)
        const probe = warmupProbe(identity.deviceId)
        const warmup = settleWarmup({
            budgetMs,
            sample: () => Object.values(signer.sign(probe).headers),
        })
        if (warmup.ready) send({ type: 'ready' })
        // 预算内没收敛：保持未就绪、进程不退。原因写清楚，别让主进程只剩一个数字
        // 原因里可能带模块绝对路径（require 失败原文就是那样），过一遍脱敏再发给主进程
        else send({ type: 'warmup-failed', kind: ERROR_KINDS.INTERNAL_ERROR, reason: mask(warmup.reason, modulePath) })
    }

    // 主进程没了（被编排器/管理员直接杀掉）：IPC 通道一断就退，别留下还占着原生模块与
    // Wine prefix 的孤儿。正常关停走下面的 shutdown 消息，不靠这条。
    process.on('disconnect', () => process.exit(0))

    process.on('message', message => {
        if (!message || typeof message !== 'object') return
        if (message.type === 'shutdown') {
            process.exit(0)
        }
        if (message.type === 'sign') {
            handleTask(signer, message)
            return
        }
        // 认不出的东西不动状态：worker 的状态机只由自己推进
    })
}

main()
