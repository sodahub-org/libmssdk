#!/usr/bin/env node
// 手动验证「Docker + Wine 下多个进程各自加载同一份 bdms.node 能不能同时工作」（#6）。
//
// 控制面在 driver 里：docker = 真环境（一个容器、同一 WINEPREFIX、两个 serve）；
// mock = 本机彩排（仓库自带的 mock 签名模块 + 假上游），在没有 Wine、没有凭据的机器上
// 验证判据流水线、三种失败形态的判定和输出脱敏本身。
//
// 判据只取外部可见事实：进程在不在、签名出不出、上游接不接受、杀掉一个后另一个还服不服务。
// 需要用户自备的原生模块与真实凭据，所以不进 npm test、不进 CI。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { maskDeviceId } from '../../src/config.mjs'
import { buildTrackV2Request, fetchTrackV2, summarizeTrackV2Response } from '../../src/probe.mjs'
import { createDockerDriver } from './driver-docker.mjs'
import { createMockDriver, SCENARIOS } from './driver-mock.mjs'

const SHAPES = {
    processStart: '进程起不来（含起来过又退出）',
    upstreamRejected: '签名能出但上游不接受',
    prefixContention: '一个进程把共享 prefix 拖垮',
    unclassified: '说不清（原始证据见 failures）',
}

const CRITERIA = [
    ['bothSign', '判据 1 两个进程同时签名'],
    ['upstreamOnce', '判据 2 各自签的头各打一次上游'],
    ['rounds', '判据 3 连打多轮'],
    ['survivor', '判据 4 杀掉一个后另一个继续服务'],
    ['identity', '判据 5 两个进程共用同一份身份'],
    ['logHygiene', '判据 6 服务日志与本输出不含敏感值'],
]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseArgs(argv) {
    const values = {}
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index]
        if (!token.startsWith('--')) continue
        const key = token.slice(2)
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) {
            values[key] = true
            continue
        }
        values[key] = next
        index += 1
    }
    return values
}

const args = parseArgs(process.argv.slice(2))
// 这些选项必须有值：`--rounds` 光写着会让 parseArgs 给出 true，而 Number(true) === 1，
// 于是静默按 1 轮跑；--track 光写着会把字符串 "true" 当曲目 id
for (const name of ['mode', 'scenario', 'track', 'rounds', 'ready-timeout-ms', 'container', 'container-ports', 'host-ports']) {
    if (args[name] !== true) continue
    console.log(`[verify] --${name} 需要带值`)
    process.exit(3)
}
const mode = args.mode || 'docker'
const scenario = args.scenario || 'ok'
if (mode !== 'docker' && mode !== 'mock') {
    console.log(`[verify] 未知 --mode：${mode}（可用：docker / mock）`)
    process.exit(3)
}
if (scenario !== 'ok' && mode !== 'mock') {
    console.log('[verify] --scenario 只在 mock 彩排模式下有效：真环境不做故障注入，只如实记录观察到的形态。')
    process.exit(3)
}
if (mode === 'mock' && !SCENARIOS.includes(scenario)) {
    console.log(`[verify] 未知 --scenario：${scenario}（可用：${SCENARIOS.join(' / ')}）`)
    process.exit(3)
}

// 彩排一律用随机哨兵串当 cookie：宿主环境里恰好导出着真实凭据时（能跑真环境的人常常如此），
// 让它进假上游与子进程环境，就不再是「不需要凭据的彩排」了
const cookie =
    mode === 'mock'
        ? `verify-mock-cookie-${crypto.randomBytes(12).toString('hex')}`
        : String(process.env.LIBMSSDK_COOKIE || '').trim()
const trackId = String(args.track || process.env.LIBMSSDK_VERIFY_TRACK_ID || (mode === 'mock' ? '1000000000000000001' : '')).trim()
// 数字参数必须先校验：--rounds 0 会让判据 3 一次都不打然后报 PASS，
// --ready-timeout-ms 非法会让探活循环直接跳过，把「什么都没观察到」报成形态三
const positiveInt = (label, value, fallback) => {
    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1) {
        console.log(`[verify] ${label} 需要正整数，收到：${JSON.stringify(value)}`)
        process.exit(3)
    }
    return parsed
}
const rounds = positiveInt('--rounds', args.rounds, mode === 'mock' ? 3 : 10)
const readyTimeoutMs = positiveInt('--ready-timeout-ms', args['ready-timeout-ms'], mode === 'mock' ? 20000 : 180000)
// 签名腿 60 秒是给 Wine 冷启动留的余量（实测热态几十到一百多毫秒）；彩排只用 15 秒，
// 因为「存活方挂住」这条判据就是靠超时来观察的
const signTimeoutMs = mode === 'mock' ? 15000 : 60000
const upstreamTimeoutMs = 15000
const outDir = path.join(import.meta.dirname, 'results')

/** 输出脱敏：登记过的敏感值不允许出现在控制台行或结果文件里，命中即记一条泄漏并替换。 */
class Redactor {
    #forbidden = []
    leaks = []

    forbid(value, kind) {
        const text = String(value || '')
        if (text.length < 4) return
        const existing = this.#forbidden.find(item => item.text === text)
        // 同一个值可能同时是 device_id 和 fp（身份文件里就如此），别把它当成「没查过」
        if (existing) {
            if (!existing.kinds.includes(kind)) existing.kinds.push(kind)
            return
        }
        this.#forbidden.push({ text, kinds: [kind] })
    }

    sanitize(where, text) {
        let output = String(text ?? '')
        for (const item of this.#forbidden) {
            if (!output.includes(item.text)) continue
            this.leaks.push({ where, kind: item.kinds[0] })
            output = output.split(item.text).join(`<已脱敏:${item.kinds.join('/')}>`)
        }
        return output
    }

    /** 只查不改：用来扫服务自己的日志里有没有出现过敏感值。 */
    find(text) {
        const kinds = new Set()
        for (const item of this.#forbidden) if (String(text || '').includes(item.text)) item.kinds.forEach(kind => kinds.add(kind))
        return [...kinds]
    }

    /** 这次实际登记了哪些类别的敏感值。 */
    kinds() {
        return [...new Set(this.#forbidden.flatMap(item => item.kinds))]
    }
}

const redactor = new Redactor()
if (cookie) redactor.forbid(cookie, 'cookie')

const say = (...parts) => process.stdout.write(`${redactor.sanitize('console', parts.join(' '))}\n`)

/** 控制面在 main 里才构造：端口或容器名写错要落到 try 的 catch，退 3 而不是裸栈退 1。 */
let driver = null

function createDriver() {
    return mode === 'mock'
        ? createMockDriver({ scenario, cookie })
        : createDockerDriver({
              container: args.container || 'libmssdk-verify-wine',
              containerPorts: (args['container-ports'] || '8899,8900').split(',').map(Number),
              hostPorts: (args['host-ports'] || '18899,18900').split(',').map(Number),
          })
}

const report = {
    schema: 'libmssdk-verify-wine-multi/1',
    issue: 'sodahub-org/libmssdk#6',
    mode,
    scenario,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    environment: {},
    processes: [],
    identity: {},
    criteria: {},
    tally: {
        signAttempts: 0,
        signFailures: 0,
        upstreamAttempts: 0,
        upstreamFailures: 0,
        shapes: { processStart: 0, upstreamRejected: 0, prefixContention: 0, unclassified: 0 },
    },
    observations: {},
    failures: [],
    verdict: '',
    redaction: { forbidden: [], leaks: 0 },
}

function phaseFailed(phase, ignoringShapes = []) {
    return report.failures.some(failure => failure.phase === phase && !ignoringShapes.includes(failure.shape))
}

function recordFailure(phase, portIndex, shape, detail) {
    report.tally.shapes[shape] += 1
    const safe = redactor.sanitize('failure', detail)
    const port = portIndex === null ? null : driver.hostPorts[portIndex]
    report.failures.push({ phase, port, shape, detail: safe })
    say(`[verify]   失败：${port === null ? '跨进程' : `端口 ${port}`} — ${SHAPES[shape]}（${safe}）`)
}

/**
 * 把一次「签不出 / 打不通」归到三种形态之一。
 * leg=upstream 表示请求本身没打出去，不能算进程问题；served 表示进程在答话、只是这单失败。
 */
async function classifyUnavailable(portIndex, { hung, served, simultaneousFailures, phase, leg = 'sign', stderrBytes = 0 }) {
    if (leg === 'upstream') return 'unclassified'
    const alive = await driver.pidAlive(portIndex)
    if (alive === null) return 'unclassified'
    if (alive === false) return 'processStart'
    if (phase === 'survivor') return hung && stderrBytes === 0 ? 'prefixContention' : 'unclassified'
    if (simultaneousFailures >= 2) return 'prefixContention'
    if (hung || served) return 'unclassified'
    return 'processStart'
}

function tagLeg(error, leg) {
    if (error && typeof error === 'object') error.leg = leg
    return error
}

/** 一次 /sign：只留长度与脱敏设备号，签名值当场登记为敏感后丢弃。 */
async function signOn(portIndex, { url, method = 'POST', body = '', headers, deviceId }) {
    const started = Date.now()
    report.tally.signAttempts += 1
    try {
        const response = await fetch(`http://127.0.0.1:${driver.hostPorts[portIndex]}/sign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url, method, body, headers, device_id: deviceId }),
            signal: AbortSignal.timeout(signTimeoutMs),
        })
        const text = await response.text()
        if (response.status !== 200) {
            // 非 200 的回包是服务的错误形状（{ok,error,code}），不含签名值，截断后留作诊断
            const error = new Error(`/sign HTTP ${response.status}: ${text.slice(0, 160)}`)
            error.served = true
            throw error
        }
        let payload
        try {
            payload = JSON.parse(text)
        } catch {
            // 200 但回包不是 JSON：进程在答话，只是答得不对，不能算「起不来」。
            // 连 JSON.parse 的报错文本都不留——Node 会把正文前缀抄进 message
            // （实测：Unexpected token 'e', "eyJIZWxpb3"... is not valid JSON），
            // 而此刻签名值还没登记为敏感，脱敏拦不住它
            const wrapped = new Error(`/sign 回包不是 JSON（${Buffer.byteLength(text)} 字节，正文与解析错误均不记录）`)
            wrapped.served = true
            throw wrapped
        }
        const signed = payload.headers || {}
        for (const value of Object.values(signed)) redactor.forbid(value, 'signature')
        redactor.forbid(payload.device_id, 'device_id')
        const lengths = { helios: String(signed['X-Helios'] || '').length, medusa: String(signed['X-Medusa'] || '').length }
        // 「两个进程都出签名」要真的验到两个头，回包空也算失败
        if (!lengths.helios || !lengths.medusa) {
            const error = new Error(`/sign 回包缺 X-Helios 或 X-Medusa（拿到 ${Object.keys(signed).length} 个头）`)
            error.served = true
            throw error
        }
        return {
            elapsedMs: Date.now() - started,
            lengths,
            deviceIdMasked: maskDeviceId(payload.device_id || deviceId),
            headers: signed,
        }
    } catch (error) {
        report.tally.signFailures += 1
        throw tagLeg(error, 'sign')
    }
}

function isHang(error) {
    const name = String(error?.name || '')
    const message = String(error?.message || '')
    const cause = String(error?.cause?.code || error?.cause?.message || '')
    return name === 'TimeoutError' || message.includes('timeout') || cause.includes('ETIMEDOUT')
}

/** 签一次名并真的打一次上游；签名头里就是发出去的那一份。 */
async function upstreamWithSignature(portIndex, device) {
    const spec = buildTrackV2Request({ trackId, deviceId: device.deviceId, iid: device.iid, fp: device.fp, cookie })
    if (driver.upstreamOrigin) {
        const target = new URL(driver.upstreamOrigin)
        const parsed = new URL(spec.url)
        parsed.protocol = target.protocol
        parsed.host = target.host
        spec.url = parsed.toString()
    }
    const signed = await signOn(portIndex, { url: spec.url, method: spec.method, body: spec.body, headers: spec.headers, deviceId: device.deviceId })
    report.tally.upstreamAttempts += 1
    let upstream
    try {
        // 出网走 src/probe.mjs 的那一个函数：与命令行 probe 同一条路径，不再自己拼 fetch
        upstream = await fetchTrackV2({
            url: spec.url,
            body: spec.body,
            headers: { ...spec.headers, ...signed.headers },
            timeoutMs: upstreamTimeoutMs,
        })
    } catch (error) {
        report.tally.upstreamFailures += 1
        throw tagLeg(error, 'upstream')
    }
    const summary = summarizeTrackV2Response(upstream.text, trackId)
    // 「上游接受」= 200 且回包能解析成曲目；4xx/5xx 即使带 JSON 也不算接受
    const accepted = upstream.status === 200 && Boolean(summary.accepted)
    if (!accepted) report.tally.upstreamFailures += 1
    return {
        sign: signed,
        upstream: {
            http: upstream.status,
            bodyBytes: Buffer.byteLength(upstream.text),
            accepted,
            fullTrack: Boolean(summary.fullTrack),
            durations: { track: summary.trackDurationSeconds || 0, stream: summary.streamDurationSeconds || 0 },
        },
    }
}

async function main() {
    say(`[verify] 模式 ${mode}${scenario === 'ok' ? '' : ` / 注入场景 ${scenario}（彩排，不是真环境结论）`} — 起控制面…`)
    driver = createDriver()
    await driver.start()
    report.processes = await driver.processes()
    report.environment = await driver.environment()
    say(`[verify] 环境：${report.environment.summary}`)

    // ——— 就绪：进程起没起来，是三种形态的第一种 ———
    const notReady = await driver.waitForReady(readyTimeoutMs)
    if (notReady.length) {
        for (const entry of notReady) {
            const stderr = await driver.stderrOf(entry.index)
            const shape = await classifyUnavailable(entry.index, {
                hung: entry.lastErrorKind === 'hung',
                served: entry.lastErrorKind === 'http',
                simultaneousFailures: notReady.length,
                phase: 'ready',
            })
            recordFailure('ready', entry.index, shape, `就绪超时，等待期间看到 ${entry.seenKinds.join('/')}；stderr ${stderr.bytes} 字节`)
        }
        report.criteria.bothSign = { status: 'FAIL', reason: '不是所有进程都就绪', portsNotReady: notReady.map(entry => driver.hostPorts[entry.index]) }
        report.observations.stderrEvidence = await Promise.all(
            driver.hostPorts.map(async (_, index) => ({ port: driver.hostPorts[index], stderr: await driver.stderrOf(index) })),
        )
        report.verdict = 'FAIL'
        say('[verify] 判据 1 失败：有进程没起来，后续判据没有意义。')
        printConclusion()
        return
    }
    say(`[verify] ${driver.hostPorts.length} 个进程都就绪（/readyz 200）`)
    // 起控制面时 pid 文件可能还没写（容器入口先跑 wineboot / 身份前置），就绪后再读一次才是真值
    report.processes = await driver.processes()

    // 身份文件要等容器入口的前置步骤跑完才存在，所以放在就绪之后读
    const identityText = await driver.readIdentityFile()
    if (!identityText) {
        report.verdict = 'INCOMPLETE'
        report.criteria.identity = { status: 'BLOCKED', reason: '进程已就绪但读不到共享身份文件' }
        say('[verify] 进程就绪了，但读不到共享身份文件（两个 serve 的 LIBMSSDK_STATE_DIR 下应有 identity.json），验证无法继续。')
        printConclusion()
        return
    }
    let identity
    try {
        identity = JSON.parse(identityText)
    } catch {
        // 同样不带 JSON.parse 的报错文本：它会抄出身份文件的前缀，而设备号此刻还没登记为敏感
        report.verdict = 'INCOMPLETE'
        report.criteria.identity = { status: 'BLOCKED', reason: `身份文件不是合法 JSON（${Buffer.byteLength(identityText)} 字节，内容不记录）` }
        say('[verify] 身份文件不是合法 JSON（正文与解析错误都不记录，避免带出设备号），验证无法继续。')
        printConclusion()
        return
    }
    for (const key of ['device_id', 'iid', 'fp']) redactor.forbid(identity[key], key)
    const device = { deviceId: identity.device_id, iid: identity.iid, fp: identity.fp }
    report.identity = { deviceIdMasked: maskDeviceId(identity.device_id), hasIid: Boolean(identity.iid), hasFp: Boolean(identity.fp) }
    say(`[verify] 共享身份 device_id=${maskDeviceId(identity.device_id)}（只以脱敏形式出现）`)

    // ——— 判据 1：两个进程同时签名（不带 cookie 的中性请求）———
    const plainSpec = {
        ...buildTrackV2Request({ trackId: trackId || '0', deviceId: device.deviceId, iid: device.iid, fp: device.fp }),
        deviceId: device.deviceId,
    }
    const signResults = await Promise.allSettled(
        driver.hostPorts.map(async (_, index) => {
            const signed = await signOn(index, plainSpec)
            return { port: driver.hostPorts[index], elapsedMs: signed.elapsedMs, lengths: signed.lengths, deviceIdMasked: signed.deviceIdMasked }
        }),
    )
    const signFailures = signResults.map((item, index) => ({ item, index })).filter(entry => entry.item.status === 'rejected')
    for (const { item, index } of signFailures) {
        const detail = String(item.reason?.message || item.reason)
        const shape = await classifyUnavailable(index, {
            hung: isHang(item.reason),
            served: Boolean(item.reason?.served),
            simultaneousFailures: signFailures.length,
            phase: 'bothSign',
        })
        recordFailure('bothSign', index, shape, `${detail}；该进程 stderr ${(await driver.stderrOf(index)).bytes} 字节`)
    }
    report.criteria.bothSign = {
        status: signFailures.length ? 'FAIL' : 'PASS',
        samples: signResults.flatMap(item => (item.status === 'fulfilled' ? [item.value] : [])),
        stderrBytes: await Promise.all(driver.hostPorts.map(async (_, index) => (await driver.stderrOf(index)).bytes)),
    }
    say(`[verify] 判据 1 ${report.criteria.bothSign.status}：${signResults.length - signFailures.length}/${signResults.length} 出签名`)

    // ——— 判据 5：两个进程读到同一份身份 ———
    // 每个进程各问一次它自己的身份视图：不点名设备号的 /sign，回包里的 device_id 就是该进程
    // 自己解析出来的那一份（原值只在内存比对）。/readyz 的脱敏值作为第二道印证。
    // 「我们发过去哪个设备号，回包就还哪个」那种比法是循环论证，所以请求里一个设备号都不给。
    const readyMasks = []
    const processIdentities = []
    for (let index = 0; index < driver.hostPorts.length; index += 1) {
        readyMasks.push((await driver.readyz(index))?.deviceId || '')
        const info = await driver.ownIdentity(index)
        redactor.forbid(info?.deviceId, 'device_id')
        processIdentities.push(info || null)
    }
    // #9 删掉了明文返回整套身份的 /config：每个进程只剩 device_id 一个原值视图，
    // iid / fp 只在「与共享身份文件一致」那一边比（两个进程读的就是同一份文件）。
    const deviceIdOf = info => String(info.deviceId)
    const fileDeviceId = String(device.deviceId)
    const expectedMask = maskDeviceId(device.deviceId)
    const masksOk = readyMasks.every(mask => mask && mask === expectedMask)
    const allRawSeen = processIdentities.every(info => info)
    // 「彼此相同」至少得有两个进程可比：单端口（手跑 --host-ports 一个值）不能空成立
    const comparable = allRawSeen && processIdentities.length >= 2
    const agreeWithEachOther = comparable && processIdentities.every(info => deviceIdOf(info) === deviceIdOf(processIdentities[0]))
    const agreeWithFile = allRawSeen && processIdentities.every(info => deviceIdOf(info) === fileDeviceId)
    // 判据说的是「两个进程读到同一份身份」：主语是进程之间，身份文件与 /readyz 是印证
    let identityStatus
    let identityNote
    if (comparable && !agreeWithEachOther) {
        identityStatus = 'FAIL'
        identityNote = '两个进程各自解析出的 device_id 互不相同：分裂（属 #2 的范围）'
    } else if (comparable && !agreeWithFile) {
        // 进程之间一致，但和共享文件对不上：判据主体成立，「来自这份文件」的印证断了，
        // 原因这里分不出来（显式覆盖？卷挂错？），所以只到 PARTIAL 并写清要人工核对什么
        identityStatus = 'PARTIAL'
        identityNote =
            '两个进程的 device_id 逐字节相同，但与共享身份文件不一致——可能是显式覆盖 LIBMSSDK_DEVICE_ID，也可能是状态目录挂错，本脚本分不出来，需要人工核对'
    } else if (comparable) {
        identityStatus = masksOk ? 'PASS' : 'PARTIAL'
        identityNote = masksOk
            ? '两个进程各自解析出的 device_id 逐字节相同，且等于共享身份文件；/readyz 的脱敏值作为第二道印证也一致（iid / fp 的原值视图已随 /config 删除，只剩文件侧可比）'
            : 'device_id 的原值比对通过（两个进程相同且等于身份文件），但有进程的 /readyz 读不到脱敏值，第二道印证缺失'
    } else if (masksOk) {
        identityStatus = 'PARTIAL'
        identityNote = allRawSeen
            ? `只有 ${processIdentities.length} 个进程，进程之间无从比对，只比了脱敏的前 3 后 3 位——不足以证明「共用同一份身份」`
            : '有进程的 /sign 读不到它自己的设备号（鉴权、进程未响应或签名失败），只比了脱敏的前 3 后 3 位——不足以证明同一份身份'
    } else {
        identityStatus = 'BLOCKED'
        identityNote = `身份判据无法执行：${allRawSeen ? '进程数不足两个，做不了进程间比对' : '原值读不到（/sign 未响应或鉴权）'}，${masksOk ? '且脱敏值不足以替代比对' : '脱敏值也读不到'}（不等于身份分裂）`
    }
    report.criteria.identity = {
        status: identityStatus,
        expected: expectedMask,
        perProcess: driver.hostPorts.map((port, index) => ({
            port,
            masked: readyMasks[index],
            rawSeen: Boolean(processIdentities[index]),
            agreesWithOtherProcesses: comparable ? agreeWithEachOther : null,
            agreesWithSharedFile: allRawSeen ? deviceIdOf(processIdentities[index]) === fileDeviceId : null,
        })),
        maskedValuesMatch: masksOk,
        comparedFields: ['device_id'],
        note: identityNote,
    }
    if (identityStatus === 'FAIL') recordFailure('identity', null, 'unclassified', identityNote)

    // ——— 判据 2：各自签的头各打一次真实上游 ———
    const hasUpstream = Boolean(cookie && trackId)
    if (!hasUpstream) {
        report.criteria.upstreamOnce = { status: 'SKIPPED', reason: '缺少 LIBMSSDK_COOKIE 或 --track，不打真实上游' }
        say('[verify] 判据 2 跳过：没有 cookie 或 track_id。判据 3 退化为只连打签名。')
    } else {
        say('[verify] 判据 2：两边各自签的头各打一次上游')
        const upstreamResults = await Promise.allSettled(driver.hostPorts.map((_, index) => upstreamWithSignature(index, device)))
        const rows = []
        // 判据 2 的两边是并发签的，一起失败就是形态三的证据；写死 1 会让这条永远判不出来。
        // 只数签名腿：上游腿一起失败是网络问题，不该冒充「共享 prefix 被拖垮」
        const simultaneous = upstreamResults.filter(item => item.status === 'rejected' && item.reason?.leg !== 'upstream').length
        for (const [index, item] of upstreamResults.entries()) {
            if (item.status === 'rejected') {
                const error = item.reason
                const detail = String(error?.message || error)
                const shape = await classifyUnavailable(index, {
                    hung: isHang(error),
                    served: Boolean(error?.served),
                    simultaneousFailures: simultaneous,
                    phase: 'upstreamOnce',
                    leg: error?.leg || 'sign',
                })
                recordFailure('upstreamOnce', index, shape, detail)
                continue
            }
            const { sign, upstream } = item.value
            rows.push({ port: driver.hostPorts[index], ...upstream, signMs: sign.elapsedMs, medusaLength: sign.lengths.medusa })
            if (!upstream.accepted) recordFailure('upstreamOnce', index, 'upstreamRejected', `HTTP ${upstream.http}，回包 ${upstream.bodyBytes} 字节`)
        }
        const passed = rows.length === driver.hostPorts.length && rows.every(row => row.accepted)
        report.criteria.upstreamOnce = { status: passed ? 'PASS' : 'FAIL', rows }
        say(`[verify] 判据 2 ${report.criteria.upstreamOnce.status}：${rows.map(row => `${row.port}→HTTP ${row.http}/${row.bodyBytes}B`).join(' ')}`)
        report.observations.fullTrackNote =
            'fullTrack 只作观察：整曲还是试听取决于账号权益与设备身份（见 #10），不是多进程判据；本票的判据是「上游接不接受这份签名」。'
    }

    // ——— 判据 3：连打多轮 ———
    say(`[verify] 判据 3：连打 ${rounds} 轮（${hasUpstream ? '每轮两边各签 + 各打一次上游' : '每轮两边各签一次'}）`)
    const roundTally = { rounds, signAttempts: 0, signFailures: 0, upstreamAttempts: 0, upstreamFailures: 0, samples: [] }
    for (let round = 1; round <= rounds; round += 1) {
        const outcomes = await Promise.allSettled(
            driver.hostPorts.map(async (_, index) => {
                if (!hasUpstream) {
                    const signed = await signOn(index, plainSpec)
                    return { port: driver.hostPorts[index], sign: { ms: signed.elapsedMs, medusa: signed.lengths.medusa }, upstream: null }
                }
                const { sign, upstream } = await upstreamWithSignature(index, device)
                return { port: driver.hostPorts[index], sign: { ms: sign.elapsedMs, medusa: sign.lengths.medusa }, upstream }
            }),
        )
        const failureCount = outcomes.filter(item => item.status === 'rejected').length
        const row = { round }
        for (const [index, item] of outcomes.entries()) {
            const port = driver.hostPorts[index]
            roundTally.signAttempts += 1
            if (item.status === 'rejected') {
                const error = item.reason
                const leg = error?.leg || 'sign'
                const detail = `${String(error?.message || error)}${leg === 'upstream' ? '（上游请求本身失败，不是签名判定）' : ''}`
                if (leg === 'sign') roundTally.signFailures += 1
                else {
                    roundTally.upstreamAttempts += 1
                    roundTally.upstreamFailures += 1
                }
                const shape = await classifyUnavailable(index, {
                    hung: isHang(error),
                    served: Boolean(error?.served),
                    simultaneousFailures: failureCount,
                    phase: 'rounds',
                    leg,
                })
                recordFailure('rounds', index, shape, `第 ${round} 轮：${detail}；该进程 stderr ${(await driver.stderrOf(index)).bytes} 字节`)
                row[port] = 'failed'
                continue
            }
            const sample = item.value
            if (sample.upstream) {
                roundTally.upstreamAttempts += 1
                if (!sample.upstream.accepted) {
                    roundTally.upstreamFailures += 1
                    recordFailure('rounds', index, 'upstreamRejected', `第 ${round} 轮：HTTP ${sample.upstream.http}，回包 ${sample.upstream.bodyBytes} 字节`)
                }
            }
            row[port] = { signMs: sample.sign.ms, medusa: sample.sign.medusa, http: sample.upstream?.http ?? null, accepted: sample.upstream?.accepted ?? null }
        }
        roundTally.samples.push(row)
        if (round === rounds || round % 5 === 0) say(`[verify]   第 ${round}/${rounds} 轮：${redactor.sanitize('console', JSON.stringify(row))}`)
    }
    const medusaLengths = new Set()
    for (const row of roundTally.samples) {
        for (const [key, value] of Object.entries(row)) if (key !== 'round' && value?.medusa) medusaLengths.add(value.medusa)
    }
    roundTally.medusaLengths = [...medusaLengths].sort((a, b) => a - b)
    roundTally.stderrBytes = {}
    for (const [index, port] of driver.hostPorts.entries()) roundTally.stderrBytes[port] = (await driver.stderrOf(index)).bytes
    roundTally.processes = await driver.processSnapshot()
    report.tally.rounds = roundTally
    report.criteria.rounds = {
        status: roundTally.signFailures === 0 && roundTally.upstreamFailures === 0 ? 'PASS' : 'FAIL',
        upstreamExecuted: hasUpstream,
        signAttempts: roundTally.signAttempts,
        signFailures: roundTally.signFailures,
        upstreamAttempts: roundTally.upstreamAttempts,
        upstreamFailures: roundTally.upstreamFailures,
        medusaLengths: roundTally.medusaLengths,
    }
    say(`[verify] 判据 3 ${report.criteria.rounds.status}：签名失败 ${roundTally.signFailures} / 上游未接受 ${roundTally.upstreamFailures}`)

    // ——— 判据 4：杀掉一个，另一个继续服务 ———
    const victimIndex = driver.hostPorts.length - 1
    const survivorIndex = 0
    say(`[verify] 判据 4：杀掉端口 ${driver.hostPorts[victimIndex]} 的进程，${driver.hostPorts[survivorIndex]} 应照常签名`)
    let killMode = null
    try {
        killMode = await driver.killProcess(victimIndex)
    } catch (error) {
        // 杀不动是控制面的问题，不该把前面几条判据的结论一起抹掉
        recordFailure('survivor', victimIndex, 'unclassified', `杀进程失败：${String(error?.message || error)}`)
    }
    report.observations.victimKillMode = killMode
    await sleep(3000)
    report.observations.processesAfterKill = await driver.processSnapshot()
    // 「被杀的进程真的没了」要两件事同时成立：pid 不在了，而且它的端口不再应答。
    // 只查 pid 会把「wine 包装进程死了、node.exe 还占着端口」误判成通过。
    const victimPidState = await driver.pidAlive(victimIndex)
    const victimPortState = await driver.probePort(victimIndex)
    // 只查 pid 会把「wine 包装进程死了、node.exe 还占着端口」读成通过；
    // 端口挂住（hung）也不算干净退出——那正是共享 prefix 出问题需要的证据。
    const victimGone = victimPidState === false && victimPortState === 'refused'
    let survivor
    try {
        const signed = await signOn(survivorIndex, plainSpec)
        survivor = { ok: true, lengths: signed.lengths, deviceIdMasked: signed.deviceIdMasked }
    } catch (error) {
        const stderr = await driver.stderrOf(survivorIndex)
        const detail = String(error?.message || error)
        const shape = await classifyUnavailable(survivorIndex, {
            hung: isHang(error),
            served: Boolean(error?.served),
            simultaneousFailures: 1,
            phase: 'survivor',
            leg: error?.leg || 'sign',
            stderrBytes: stderr.bytes,
        })
        recordFailure('survivor', survivorIndex, shape, `${detail}；存活方 stderr ${stderr.bytes} 字节`)
        survivor = { ok: false, hung: isHang(error), stderrBytes: stderr.bytes, stderrTail: stderr.tail }
    }
    report.observations.victimGone = victimGone
    report.observations.victimPortState = victimPortState
    if (victimPidState === null) recordFailure('survivor', victimIndex, 'unclassified', '读不到被杀进程的 pid 文件，无法判断它是否还在')
    else if (victimPortState === 'hung') recordFailure('survivor', victimIndex, 'unclassified', '被杀方端口接了但不答话，不是干净退出')
    else if (victimPortState === 'ready' || victimPortState === 'http')
        recordFailure('survivor', victimIndex, 'unclassified', '被杀方仍在应答 /readyz，杀没生效')
    else if (victimPidState) recordFailure('survivor', victimIndex, 'unclassified', '被杀进程的 pid 仍存活')
    if (hasUpstream && survivor.ok) {
        try {
            const { upstream } = await upstreamWithSignature(survivorIndex, device)
            survivor.upstream = { http: upstream.http, bodyBytes: upstream.bodyBytes, accepted: upstream.accepted }
            if (!upstream.accepted) recordFailure('survivor', survivorIndex, 'upstreamRejected', `存活进程签出的头被打回：HTTP ${upstream.http}`)
        } catch (error) {
            recordFailure('survivor', survivorIndex, 'unclassified', `存活进程打上游失败：${String(error?.message || error)}`)
        }
    }
    report.criteria.survivor = {
        // 判据 4 只判「服务断没断」；存活方的上游被拒是形态二，已经记进 failures 并计入计数，
        // 但它不该把「另一个进程继续服务」这条判据翻成 FAIL —— 那是判据 2/3 的领域
        status: survivor.ok && victimGone && !phaseFailed('survivor', ['upstreamRejected']) ? 'PASS' : 'FAIL',
        victimPort: driver.hostPorts[victimIndex],
        survivorPort: driver.hostPorts[survivorIndex],
        victimGone,
        survivor,
        survivorStderrBytes: (await driver.stderrOf(survivorIndex)).bytes,
    }
    const survivorReason = survivor.ok ? '存活方继续出签名' : '存活方不再出签名'
    say(`[verify] 判据 4 ${report.criteria.survivor.status}：${survivorReason}${survivor.ok && phaseFailed('survivor') ? '，但该阶段另有失败记录（见上）' : ''}`)

    // ——— 判据 6：服务自己的日志不该出现 cookie / 签名值 / 完整设备号 ———
    const leakedKinds = new Set()
    let scannedBytes = 0
    for (let index = 0; index < driver.hostPorts.length; index += 1) {
        const text = await driver.readLogText(index)
        scannedBytes += Buffer.byteLength(text)
        for (const kind of redactor.find(text)) leakedKinds.add(kind)
    }
    // 没跑过带 cookie 的判据时，「日志里没有 cookie」这条并没有被真正检验过，不能算 PASS
    const scannedFor = redactor.kinds()
    const uncovered = ['cookie', 'device_id', 'iid', 'fp'].filter(kind => !scannedFor.includes(kind))
    // 登记了 cookie 不等于检验过 cookie：没有 --track 时它根本没进过任何签名与日志
    const cookieCovered = scannedFor.includes('cookie') && hasUpstream
    report.criteria.logHygiene = {
        status: leakedKinds.size ? 'FAIL' : cookieCovered ? 'PASS' : 'PARTIAL',
        scannedBytes,
        scannedFor,
        leakedKinds: [...leakedKinds],
        // fp 与 device_id 同值时只会登记一次，所以这里报「查过哪些值」而不是「查过哪些名字」
        note: cookieCovered
            ? ''
            : `没有 cookie 参与签名，日志扫描只覆盖了 ${scannedFor.join('/') || '（空）'}；未覆盖：${uncovered.join('/') || '无'}`,
    }
    if (leakedKinds.size) recordFailure('logHygiene', null, 'unclassified', `服务日志里出现了敏感值：${[...leakedKinds].join(', ')}`)
    say(`[verify] 判据 6 ${report.criteria.logHygiene.status}：扫了 ${scannedBytes} 字节 serve 日志（查 ${scannedFor.join('/') || '无'}）`)

    // ——— 判据 7（记录，不参与门禁）：docker stop 期间到底先看到 503 还是连接被拒 ———
    // #23 的证据：修好后应当先读到可读的 503（entrypoint 转发 SIGINT → Node 改口 → 排空窗口），
    // 最后才变成连接被拒；没修好时从头就是 refused。Wine 的 Ctrl+C 转发有版本回归风险，
    // 所以这里如实记录形态序列，不折成一个通过/失败去掩盖差异。
    if (typeof driver.observeStop === 'function') {
        // 判据 7 只是记录：观察阶段自己出错（容器已经不在、docker exec 失败……）不能把已经
        // 跑完的 1–6 一起报成「未执行」——就地 catch，记一条 ERROR，结论照常出。
        try {
            say('[verify] 判据 7 观察：docker stop 期间 /readyz 的形态（最多 30 秒宽限）…')
            // 判据 4 已经杀掉一个进程，它的端口注定是 refused；只观察停之前还活着的那些。
            const alive = []
            for (let index = 0; index < driver.hostPorts.length; index += 1) {
                if ((await driver.pidAlive(index)) === true) alive.push(index)
            }
            if (alive.length === 0) {
                report.observations.stopObservation = {
                    status: 'SKIPPED',
                    reason: '停止前已经没有活着的 serve 进程（前面的判据已把进程杀光），没有可观察的收尾',
                }
                say('[verify] 判据 7 SKIPPED：停止前没有活着的 serve 进程')
            } else {
                const observed = await driver.observeStop({ graceSeconds: 30, indexes: alive })
                const sawReadable503 = observed.sequences.map(entry => entry.sequence.includes('http-503'))
                const graceful = sawReadable503.filter(Boolean).length
                report.observations.stopObservation = {
                    status:
                        sawReadable503.length > 0 && graceful === sawReadable503.length
                            ? 'saw-503'
                            : graceful > 0
                              ? 'mixed'
                              : 'refused-only',
                    graceful,
                    processes: sawReadable503.length,
                    alivePorts: observed.sequences.map(entry => entry.port),
                    sequences: observed.sequences.map(entry => `${entry.port}: ${entry.sequence.join(' → ')}`),
                    ...(observed.stopError ? { stopError: observed.stopError } : {}),
                }
                say(`[verify] 判据 7 ${report.observations.stopObservation.status}：${report.observations.stopObservation.sequences.join(' | ')}`)
            }
        } catch (error) {
            const detail = redactor.sanitize('stop-observation', String(error?.message || error))
            report.observations.stopObservation = { status: 'ERROR', reason: detail }
            say(`[verify] 判据 7 ERROR：${detail}`)
        }
    } else {
        report.observations.stopObservation = {
            status: 'SKIPPED',
            reason: '彩排模式没有容器可停，Wine 的信号转发在这里不成立',
        }
        say('[verify] 判据 7 SKIPPED：彩排模式没有容器可停')
    }

    printConclusion()
}

function printConclusion() {
    const rows = CRITERIA.map(([key, label]) => [label, report.criteria[key]?.status || 'NOT_RUN'])
    const failing = rows.filter(([, status]) => status === 'FAIL')
    const skipped = rows.filter(([, status]) => ['SKIPPED', 'BLOCKED', 'NOT_RUN', 'PARTIAL'].includes(status))
    const shapeCounts = Object.entries(report.tally.shapes).filter(([, count]) => count > 0)
    // 只要记过一条失败，整体结论就不能是「通过」——哪怕它落在的那条判据本身 PASS
    // （判据 4 只管服务连续性，存活方的上游被拒照样记进形态二，那件事必须反映到结论上）
    report.verdict = failing.length || report.failures.length ? 'FAIL' : skipped.length ? 'INCOMPLETE' : 'PASS'

    say('[verify] ============ 结论 ============')
    for (const [label, status] of rows) say(`[verify] ${label}：${status}`)
    say(`[verify] 环境：${report.environment.summary}`)
    say(
        `[verify] 计数：签名 ${report.tally.signAttempts} 次（失败 ${report.tally.signFailures}）/ 上游 ${report.tally.upstreamAttempts} 次（未接受 ${report.tally.upstreamFailures}）`,
    )
    say(`[verify] 失败形态：${shapeCounts.length ? shapeCounts.map(([shape, count]) => `${SHAPES[shape]} ${count}`).join(' / ') : '无'}`)
    if (report.observations.fullTrackNote) say(`[verify] 备注：${report.observations.fullTrackNote}`)
    say(`[verify] 结论：${{ PASS: '通过', FAIL: '失败', INCOMPLETE: '部分完成（有判据未执行）' }[report.verdict]}`)
}

try {
    await main()
} catch (error) {
    // 控制面本身没起来（容器没在跑、docker 不可用…）：这既不是「失败」也不是「部分完成」，
    // 是根本没跑成 —— 用 3，并且只输出脱敏后的一行，不把裸栈打进日志
    const detail = redactor.sanitize('fatal', String(error?.message || error))
    process.stdout.write(`[verify] 执行中断，验证没有真正跑起来：${detail}\n`)
    process.stdout.write('[verify] 结论：未执行（前置条件或控制面问题）\n')
    report.verdict = 'NOT_RUN'
    process.exitCode = 3
} finally {
    // 清理抛异常不能把结论一起吞掉：结果文件、退出码都要照常走完
    try {
        await driver?.teardown?.()
    } catch (error) {
        const detail = redactor.sanitize('teardown', String(error?.message || error))
        process.stdout.write(`[verify] 控制面清理失败（不影响结论）：${detail}\n`)
    }
    report.finishedAt = new Date().toISOString()
    // 先算 redaction 再序列化，否则写进文件的那份永远是空计数
    report.redaction = { forbidden: redactor.kinds(), leaks: redactor.leaks.length }
    const serialized = redactor.sanitize('report', `${JSON.stringify(report, null, 2)}\n`)
    if (redactor.leaks.length) {
        const kinds = [...new Set(redactor.leaks.map(item => item.kind))].join(', ')
        process.stdout.write(`[verify] 脱敏失败：输出里出现过敏感值（${kinds}），结果不写盘。\n`)
        process.exitCode = 1
    } else {
        try {
            fs.mkdirSync(outDir, { recursive: true })
            const file = path.join(outDir, `verify-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
            fs.writeFileSync(file, serialized)
            say(`[verify] 结果写入 ${file}`)
        } catch (error) {
            // 说「通过」却没能留下证据，才算失败；已经有非零退出码的结论不被改写
            process.stdout.write(`[verify] 结果写盘失败：${redactor.sanitize('write', String(error?.message || error))}\n`)
            if (report.verdict === 'PASS') process.exitCode = 1
        }
        if (report.verdict === 'FAIL') process.exitCode = 1
        if (report.verdict === 'INCOMPLETE') process.exitCode = 2
    }
}
