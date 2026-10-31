// 假的 bdms.node：在 Linux/CI 上跑测试用。
// 它的输出是确定性的，方便断言"签名确实覆盖了 URL + 请求头"。
//
// 三个开关只为「真进程」那组用例服务，默认全关（原有断言看不出差别）：
//   MOCK_BDMS_UNSTABLE_CALLS —— 前 N 次输出比稳态短，复刻真机 init 之后那段短签名窗口
//   MOCK_BDMS_SIGN_DELAY_MS  —— 每次调用同步阻塞若干毫秒，复刻「一次签名吃满一个核几百毫秒」
//   MOCK_BDMS_TRACE_DIR      —— 每次调用落一条 {url,startedAt,endedAt}，用来证明并发确实重叠

import fs from 'node:fs'
import path from 'node:path'

let currentDeviceId = ''

const unstableCalls = Number(process.env.MOCK_BDMS_UNSTABLE_CALLS || 0)
const signDelayMs = Number(process.env.MOCK_BDMS_SIGN_DELAY_MS || 0)
const traceDir = String(process.env.MOCK_BDMS_TRACE_DIR || '').trim()
let calls = 0
let traceSeq = 0

let sleepSlot

/** 同步等一小会儿：真模块就是同步阻塞的，异步等待反而测不出「这台 worker 正忙」。 */
function sleepSync(ms) {
    sleepSlot ??= new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(sleepSlot, 0, 0, ms)
}

export function init({ deviceId } = {}) {
    currentDeviceId = String(deviceId || '')
}

export function generateHttpSignatureHeaders(url, headerLines) {
    calls += 1
    const startedAt = Date.now()
    if (signDelayMs > 0) sleepSync(signDelayMs)
    if (traceDir) {
        traceSeq += 1
        try {
            fs.writeFileSync(
                path.join(traceDir, `call-${process.pid}-${traceSeq}.json`),
                JSON.stringify({ url: String(url), startedAt, endedAt: Date.now() }),
            )
        } catch {
            /* 追踪失败不该影响签名本身 */
        }
    }
    const digest = (value) => {
        // 不用 crypto，纯字符串散列即可（测试只需要"输入不同 → 输出不同"）
        let hash = 2166136261
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index)
            hash = Math.imul(hash, 16777619)
        }
        return (hash >>> 0).toString(36)
    }
    const helios = `mock-helios-${digest(`${currentDeviceId}|${url}`)}`
    const medusa = `mock-medusa-${digest(`${url}|${headerLines}|${currentDeviceId}`)}`
    // 冷启动窗口：同一批头，长度偏短。就绪判据要是「等到了某个数」，这里就会把它骗过去
    const shortened = calls <= unstableCalls ? medusa.slice(0, -4) : medusa
    return [`X-Helios`, helios, `X-Medusa`, shortened].join('\r\n')
}

export function report() {}
