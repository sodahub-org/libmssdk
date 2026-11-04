#!/usr/bin/env node
// 对照实验：整曲还是试听，到底由「Cookie」「签名构造」「设备身份」里的哪一个决定。
//
// 一次运行只打 `POST /luna/pc/track_v2`（外加一条免签名的 SEO 对照），
// 每条 Arm 只改变声明出来的那几个字段，其余逐字节相同。
//
// 凭据边界：cookie 只从本机读取（环境变量 / 本机配置文件 / 指定文件），不落盘、不打印；
// 输出只有请求形状、脱敏设备号、签名长度、判定用的标量，以及曲目号末四位
// （曲名与完整曲目号属于个人收听记录，不进输出，因此日志可以直接贴进票里）。
//
//   node tools/entitlement-matrix.mjs --list                       # 只看矩阵，不打网络
//   node tools/entitlement-matrix.mjs --track <id> --arm good-ts   # 只跑一条
//   node tools/entitlement-matrix.mjs --track <id> --repeat 2      # 跑全部（重复关键条）
//   node tools/entitlement-matrix.mjs --track <id> --arm captured \
//        --from-capture <抓包件>                                   # 票里原本要的那一条
//   node tools/entitlement-matrix.mjs --arm account-me             # 账号自己的会员标记

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { BdmsSigner } from '../src/bdms.mjs'
import { loadConfig, maskDeviceId } from '../src/config.mjs'
import { randomDeviceId } from '../src/identity.mjs'
import { summarizeTrackV2Response } from '../src/probe.mjs'

const PC_TRACK_V2 = 'https://api.qishui.com/luna/pc/track_v2'
const PC_ME = 'https://api.qishui.com/luna/pc/me'
const SEO_TRACK = 'https://beta-luna.douyin.com/luna/h5/seo_track'
const WEB_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

/** 客户端版本画像；UA 与 version_code 成对出现，拆开跑才知道谁在决定权益。 */
export const APP_PROFILES = {
    luna330: { version_name: '3.3.0', version_code: '30030000', user_agent: 'LunaPC/3.3.0(359450208)' },
    luna380: { version_name: '3.8.0', version_code: '30080000', user_agent: 'LunaPC/3.8.0(467160162)' },
}

/**
 * 设备身份形状。
 * - `ts`：libresoda 在配置为空时落到 URL 里的毫秒时间戳（13 位，每次都不一样）。
 * - `rand16`：本仓库 `randomDeviceId()` 的 16 位形状，每次运行换一个。
 * - `service`：本服务落盘的那一份身份（`data/identity.json`）。
 * - `captured`：外部传进来的那一份（抓包得到的真实设备身份，走 `--device/--iid/--fp`）。
 */
export function buildIdentity(shape, seed = {}) {
    if (shape === 'ts') {
        const now = seed.now ?? Date.now()
        const deviceId = String(now)
        return { deviceId, iid: String(now + 1), fp: deviceId, shape }
    }
    if (shape === 'rand16') {
        const deviceId = seed.deviceId || randomDeviceId()
        return { deviceId, iid: seed.iid || randomDeviceId(), fp: deviceId, shape }
    }
    if (shape === 'service') {
        return { deviceId: seed.deviceId, iid: seed.iid, fp: seed.fp, shape }
    }
    if (shape === 'captured') {
        if (!seed.deviceId) throw new Error('captured 身份需要 --device <device_id>（抓包得到的那一份）')
        return {
            deviceId: seed.deviceId,
            iid: seed.iid || seed.deviceId,
            fp: seed.fp || seed.deviceId,
            shape,
        }
    }
    throw new Error(`未知设备身份形状：${shape}`)
}

/** 与 Go `url.QueryEscape` 一致：`A-Za-z0-9-_.~` 直通，空格转 `+`，其余 `%XX`。 */
export function queryEscape(value) {
    return encodeURIComponent(String(value))
        .replace(/%20/g, '+')
        .replace(/[!*'()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** 与 libresoda `Params::encode` 一致：键按字典序排列后用 `&` 拼接。 */
export function encodeSortedParams(params) {
    return Object.entries(params)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${queryEscape(key)}=${queryEscape(value)}`)
        .join('&')
}

/** 公共查询参数；顺序与取值都照抄客户端，只有 identity / app 两处按 arm 替换。 */
export function buildPcCommonParams(identity, app) {
    return {
        ac: 'wifi',
        aid: '386088',
        app_name: 'luna_pc',
        build_mode: 'master',
        cdid: '',
        channel: 'official',
        device_id: identity.deviceId,
        device_platform: 'windows',
        device_type: 'Windows',
        fp: identity.fp,
        geo_region: 'cn',
        iid: identity.iid,
        network_carrier: '',
        os_region: 'cn',
        os_version: 'Windows 11',
        region: 'cn',
        resolution: '',
        sim_region: '',
        tz_name: 'Asia/Shanghai',
        version_code: app.version_code,
        version_name: app.version_name,
    }
}

/**
 * 这份构造与 `src/probe.mjs` 的 `buildTrackV2Request` **故意不合并**：那边是本服务对外
 * 的形状（插桩序、带 x-tt-trace-id），这边要逐字节复刻调用方客户端的形状（字典序、
 * 空格转 `+`）。两者各自被自己的测试守着，合成一份就同时丢掉两个被测对象。
 */
export function buildPcTrackV2Request({ trackId, identity, app, localUser = '1', cookie = '' }) {
    const params = buildPcCommonParams(identity, app)
    const body = JSON.stringify({
        track_id: String(trackId),
        media_type: 'track',
        queue_type: 'favorite_track_playlist',
        scene_name: 'library',
    })
    // 头部顺序照客户端实际发出的那一份；签名覆盖的必须就是发出去的这一份。
    const headers = [
        ['user-agent', app.user_agent],
        ['x-luna-background-type', 'foreground'],
        ['x-luna-is-background-req', '0'],
        ['x-luna-is-local-user', localUser],
        ['content-type', 'application/json; charset=utf-8'],
        ['x-ss-stub', crypto.createHash('md5').update(body).digest('hex').toUpperCase()],
    ]
    if (cookie) headers.push(['cookie', cookie])
    return { url: `${PC_TRACK_V2}?${encodeSortedParams(params)}`, params, body, headers }
}

/**
 * `GET /luna/pc/me`：公共参数与 `track_v2` 同一份，但没有请求体，所以客户端这里
 * 既不发 `content-type` 也不发 `x-ss-stub`（照 libresoda `pc_request_options` 的形状）。
 * 这条只用来读账号自身的会员标记，不判任何曲目 —— 曲目授权是另一条 arm 的事。
 */
export function buildPcMeRequest({ identity, app, cookie = '' }) {
    const params = buildPcCommonParams(identity, app)
    const headers = [
        ['user-agent', app.user_agent],
        ['x-luna-background-type', 'foreground'],
        ['x-luna-is-background-req', '0'],
        ['x-luna-is-local-user', '1'],
    ]
    if (cookie) headers.push(['cookie', cookie])
    return { url: `${PC_ME}?${encodeSortedParams(params)}`, params, body: '', headers }
}

/**
 * 实验矩阵。每条 arm 的 `changes` 就是它与 `good-ts` 基线之间唯一的不同，
 * `touches` 是这份不同落在请求上的字段，离线测试会逐条核对：
 * 任何一条 arm 只能动它声明过的字段，否则对照实验不成立。
 */
export const BASELINE = 'good-ts'
export const ARMS = [
    {
        name: 'good-ts',
        expect: '整曲（正对照：复刻本机播放器正在拿到整曲的那条请求）',
        changes: '身份=毫秒时间戳（每次不同）· 客户端 3.3.0 · local-user=1 · 带 Cookie',
        touches: [],
        request: { identity: 'ts', app: APP_PROFILES.luna330, localUser: '1', useCookie: true },
    },
    {
        name: 'rand16',
        expect: '待定：只把身份换成一个全新的 16 位设备号',
        changes: '身份=全新随机 16 位（其余与 good-ts 相同）',
        touches: ['query.device_id', 'query.iid', 'query.fp'],
        request: { identity: 'rand16', app: APP_PROFILES.luna330, localUser: '1', useCookie: true },
    },
    {
        name: 'service-id',
        expect: '待定：复刻当初扫 7 首全试听时的那份身份',
        changes: '身份=服务落盘的固定 16 位（其余与 good-ts 相同）',
        touches: ['query.device_id', 'query.iid', 'query.fp'],
        request: { identity: 'service', app: APP_PROFILES.luna330, localUser: '1', useCookie: true },
    },
    {
        name: 'probe-shape',
        // 只复刻 `probe` 的身份 / 版本号 / local-user。src/probe.mjs 还额外发
        // x-tt-trace-id 与 accept-encoding，那两个头本条没复刻，
        // 所以这一行不能替 shipped probe 的完整请求背书（调查报告第七节记了这条）。
        expect: '待定：`probe` 用的那份身份 + 3.8.0 + local-user=0（不含它另外两个头）',
        changes: '身份=服务落盘 16 位 · 客户端 3.8.0 · local-user=0',
        touches: [
            'query.device_id',
            'query.iid',
            'query.fp',
            'query.version_name',
            'query.version_code',
            'header.user-agent',
            'header.x-luna-is-local-user',
        ],
        request: { identity: 'service', app: APP_PROFILES.luna380, localUser: '0', useCookie: true },
    },
    {
        name: 'app380',
        expect: '待定：只把版本号/UA 推到 3.8.0，身份仍用时间戳',
        changes: '客户端 3.8.0（身份仍是时间戳）',
        touches: ['query.version_name', 'query.version_code', 'header.user-agent'],
        request: { identity: 'ts', app: APP_PROFILES.luna380, localUser: '1', useCookie: true },
    },
    {
        name: 'localuser0',
        expect: '待定：只把 x-luna-is-local-user 从 1 改成 0',
        changes: 'local-user=0（身份仍是时间戳）',
        touches: ['header.x-luna-is-local-user'],
        request: { identity: 'ts', app: APP_PROFILES.luna330, localUser: '0', useCookie: true },
    },
    {
        name: 'captured',
        expect: '票里原本要求的那一条：抓包来的真实设备身份（--from-capture 或 --device/--iid/--fp）',
        changes: '身份=抓包里那份真实设备号（其余与 good-ts 相同）',
        touches: ['query.device_id', 'query.iid', 'query.fp'],
        request: { identity: 'captured', app: APP_PROFILES.luna330, localUser: '1', useCookie: true },
    },
    {
        name: 'no-cookie',
        expect: '待定（匿名对照：Cookie 在这条接口上到底参与不参与判定）',
        changes: '不发 Cookie（其余与 good-ts 相同）',
        touches: ['header.cookie'],
        request: { identity: 'ts', app: APP_PROFILES.luna330, localUser: '1', useCookie: false },
    },
    {
        name: 'sig-mismatch',
        expect: '待定：让 URL 设备号与签名器设备号不一致，看上游认不认得出来',
        changes: '请求形状与基线逐字节相同，只是用另一个 16 位设备号签名',
        touches: [],
        request: { identity: 'ts', app: APP_PROFILES.luna330, localUser: '1', useCookie: true, signWith: 'other16' },
    },
    {
        name: 'no-sign',
        expect: '预期空 body（必要性对照：没有签名还剩什么）',
        changes: '请求形状与基线逐字节相同，只是不带 x-helios / x-medusa',
        touches: [],
        request: { identity: 'ts', app: APP_PROFILES.luna330, localUser: '1', useCookie: true, skipSign: true },
    },
    {
        name: 'seo-web',
        expect: '免签名基线：曲目本身多长、试听多长、是否会员曲',
        changes: '不走签名，GET h5/seo_track',
        touches: ['(整条请求都不同：免签名的网页接口)'],
        request: { seo: true },
    },
    {
        name: 'account-me',
        // 「试听级到底是账号没权益还是曲目没授权」这条推断需要一个账号侧读数才能收口：
        // /luna/pc/me 直接回本账号的会员标记，不参与曲目判定，也不出签名。
        expect: '账号自身的会员标记 is_vip，加上回包认不认这份登录态（hasUser）；两个布尔值，不判任何曲目',
        changes: '不走签名，GET /luna/pc/me（带 Cookie，身份仍用时间戳）',
        touches: ['(整条请求都不同：账号档位端点)'],
        request: { me: true, identity: 'ts', app: APP_PROFILES.luna330, useCookie: true },
    },
]

/**
 * 这两条打的不是 `track_v2`，整条请求都与基线不同，所以「一次只动声明过的那几个字段」
 * 这条不变量对它们不适用。判据只有一个来源：看这条 arm 自己走的是哪条请求路径。
 */
export const isOffBaseline = arm => Boolean(arm.request.seo || arm.request.me)

/** 档位那条与曲目无关，不需要 `--track`；其余各条都要拿一首曲子去判。 */
export const needsTrack = arm => !arm.request.me

/**
 * 只保留判定用的标量。字符串一律不收（`status_msg` 这类里可能夹着地址、标识或提示文案），
 * 数字与布尔按键名白名单收；键名命中黑名单的直接跳过。
 */
export function extractScalars(rawBody) {
    let payload
    try {
        payload = JSON.parse(String(rawBody || ''))
    } catch {
        return {}
    }
    const picked = {}
    const walk = (node, trail) => {
        if (!node || typeof node !== 'object' || trail.length > 4) return
        for (const [key, value] of Object.entries(node)) {
            const pathText = `${trail.join('.')}${trail.length ? '.' : ''}${key}`
            if (/url|token|sign|helios|medusa|cookie|auth|secret|id$/i.test(key)) continue
            if (typeof value === 'number' || typeof value === 'boolean') {
                if (/status_code|error|duration|is_vip|vip|preview|tier|level/i.test(key)) picked[pathText] = value
                continue
            }
            if (typeof value === 'object' && value !== null) walk(value, [...trail, key])
        }
    }
    walk(payload, [])
    return picked
}

function safeParse(text) {
    try {
        return JSON.parse(String(text || ''))
    } catch {
        return null
    }
}

/**
 * 抓包件（`tools/signer-tee.mjs` 产的 JSONL，POSIX 上 0600，只在本机）里取最后一份带 device_id 的身份。
 * 设备号走文件而不是命令行参数：argv 会进 shell 历史与进程列表，那是本机里唯一一处
 * 会把真实设备号顺手留给别人的地方。坏行跳过（尾部可能是半行），一份都读不出就报错；
 * 那份带 device_id 的记录本身必须三个号齐全，缺一个也报错——不回落到更早那一条。
 * 回包里带上选中那一条的 `at`，以及它在文件里的行号（`line` / `lineCount` 都按物理行算，
 * 空行与坏行也占号：这一对要能直接翻到那一行去核，改成记录数就和 `line` 对不上了）。
 * 读数用的是件里哪一份，操作者必须看得见——启动行与 captured 的 row 都带着它，
 * 否则「最新那一份」与「回落到的那一份」在读数上无法区分。
 */
/**
 * 这个错是不是「件里的数据本身不成立」。`captureIdentity` 主动判死的错都带 `short`；
 * 编程错误（TypeError 之类）没有——跑整轮时不能把它降级成一句提示，否则 captured 会被悄悄跳过。
 */
export function isKnownCaptureProblem(error) {
    return Boolean(error && typeof error.short === 'string' && error.short)
}

/** 行数口径：总行数 + 零计数不打印的细项——空行 / 不是记录的行 / 没有 device_id 的记录。 */
function lineBreakdown({ lineCount, blank = 0, skipped = 0, noDevice = 0 }) {
    return [
        `共 ${lineCount} 行`,
        blank ? `空行 ${blank} 条` : '',
        skipped ? `不是记录的行 ${skipped} 条` : '',
        noDevice ? `没有 device_id 的记录 ${noDevice} 条` : '',
    ]
        .filter(Boolean)
        .join('，')
}

export function captureIdentity(text) {
    // 记事本另存会带 BOM：它让第一行的 JSON.parse 必然失败，那条记录就悄悄没了——
    // 件里只有一条记录时会报「没有带 device_id 的记录」，文件明明有。
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)
    // 件尾那个换行会被切出一个空段，它不是一行记录。
    const lineCount = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    const absent = value => value === undefined || value === null || (typeof value === 'string' && !value.trim())
    // at 是件里的原文，会进启动行、报错与读数。只认 ISO 8601 时刻（tee 写 Z 形式，
    // 带偏移的也是合法 ISO）；其它内容（控制字符、转义序列、长标识符）一律当「没记」。
    const asMoment = value => {
        const text = typeof value === 'string' ? value.trim() : ''
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return ''
        return Number.isNaN(Date.parse(text)) ? '' : text
    }
    const typeName = value =>
        Array.isArray(value)
            ? '数组'
            : typeof value === 'boolean'
              ? '布尔值'
              : typeof value === 'number'
                ? '数字'
                : value && typeof value === 'object'
                  ? '对象'
                  : typeof value
    // 报错同时带一句短原因与坐标：调用方要转述时（「本次没用它」那行），
    // 整句塞进括号会变成五层嵌套，只有短句才读得顺。
    const fail = (message, short, extra = {}) => {
        const error = new Error(message)
        error.short = short
        Object.assign(error, extra)
        throw error
    }
    let latest = null
    let picked = null
    let blank = 0
    let skipped = 0
    let noDevice = 0
    // 只数「文件里的行」：件尾那个换行切出来的空段不算（lineCount 已经扣掉它）。
    for (const [index, line] of lines.slice(0, lineCount).entries()) {
        if (!line.trim()) {
            blank += 1
            continue
        }
        const record = safeParse(line)
        const identity = record && typeof record === 'object' && !Array.isArray(record) ? record.identity : null
        const usable = identity && typeof identity === 'object' && !Array.isArray(identity)
        if (!usable) {
            // 尾部半行是正常的（tee 在追加），但不是记录的行数必须报出来：
            // 「共 3 行」与「件里只有 2 条记录」对不上时，看的人才知道差在哪儿。
            // 判据是「是不是一条带 identity 对象的记录」，不是「JSON.parse 出来是不是真值」——
            // 否则 null / 0 / false 被数成坏行，而 identity 是字符串的行反而不算。
            skipped += 1
            continue
        }
        if (!absent(identity.deviceId)) {
            latest = identity
            picked = { at: asMoment(record.at), line: index + 1 }
        } else {
            // 有记录、但没有 device_id：既不进「不是记录」，也不进「可用记录」。
            // 不单独数出来的话，「跳过 0 条」会和「没有记录」并排，读起来像文件没问题。
            noDevice += 1
        }
    }
    // 一条都没有时，最少要能分清「件是空的」与「件里的行都不是记录」：行数口径都带上。
    if (!latest) {
        fail(
            `抓包件里没有带 device_id 的记录（${lineBreakdown({ lineCount, blank, skipped, noDevice })}；` +
                '只记 PC 客户端的业务请求）',
            '没有带 device_id 的记录',
        )
    }
    // 只收字符串：数字的字面在 JSON.parse 那一步就没了——9007199254740993 变 …992、
    // 1e15 变 1000000000000000、0.5 原样留着但写成 1e-1 也行。保不住「件里写的那个串」，就不收。
    const asText = field => {
        const value = latest[field]
        if (value === undefined || value === null) return ''
        if (typeof value !== 'string') {
            fail(
                `抓包件里第 ${picked.line} 行（共 ${lineCount} 行）的 identity.${field} 是${typeName(value)}，` +
                    `不是字符串——${
                        typeof value === 'number' ? '数字的字面保不住，件里请写成字符串' : '那不是一份身份'
                    }`,
                `identity.${field} 是${typeName(value)}`,
                { line: picked.line, lineCount },
            )
        }
        return value.trim()
    }
    const deviceId = asText('deviceId')
    const iid = asText('iid')
    const fp = asText('fp')
    // 不拿 device_id 顶空缺：真机本来就满足 fp = device_id，顶完之后单看读数与真的逐字节相同，
    // 那份身份就不再是「文件里的原值」了。齐不齐由 #32 那道门口拦，这里只负责不再自己编。
    if (!iid || !fp) {
        const missing = [!iid && 'iid', !fp && 'fp'].filter(Boolean).join(' / ')
        // 报的行号与 at 是文件里那条的坐标，不是设备号：操作者据此能直接翻到那一行核对，
        // 也不会把「这份不齐」读成「程序回头用了早前那份齐的」。
        fail(
            `抓包件里第 ${picked.line} 行（共 ${lineCount} 行，at ${picked.at || '未记时间'}）身份不齐（缺 ${missing}）` +
                '——不顶替；更早那一条就算齐也不回头用，读数只认最后一份',
            `缺 ${missing}`,
            { line: picked.line, lineCount },
        )
    }
    return { deviceId, iid, fp, at: picked.at, line: picked.line, lineCount, blank, skipped, noDevice }
}

/** cookie 只从本机读：`env` 取环境变量，`sodam` 取本机播放器配置，其余按文件路径读。 */
function readCookie(source) {
    const candidates = {
        env: () => (process.env.LIBMSSDK_COOKIE || '').trim(),
        sodam: () => {
            const root = process.env.APPDATA || path.join(process.env.HOME || '', '.config')
            return String(JSON.parse(fs.readFileSync(path.join(root, 'sodam', 'config.json'), 'utf8')).cookie || '').trim()
        },
    }
    if (candidates[source]) return candidates[source]()
    const text = fs.readFileSync(source, 'utf8').trim()
    return source.endsWith('.json') ? String(JSON.parse(text).cookie || '').trim() : text
}

// 参数一律写成 `--名字 值` 或 `--名字=值`，两种等价。以前只做 indexOf('--名字')，于是 `=` 写法
// 整条落空：互斥判据被绕过、抓包件被静默忽略、`--arm=captured` 悄悄变成跑整矩阵。
const VALUE_FLAGS = new Set(['arm', 'track', 'repeat', 'cookie-from', 'from-capture', 'device', 'iid', 'fp'])
const BOOL_FLAGS = new Set(['list'])

export function parseArgs(argv) {
    // 报错要能贴进票里：手滑成位置参数的 16 位设备号不能被复读一遍。
    // 名字默认照原样点名（白名单式判据会把点号、冒号那类拼错整片匿名）；只有两种收起来：
    // 超长 token（防刷屏），以及名字里连续 ≥8 位数字（多半是手滑贴上的设备号，本项目是 13–16 位）。
    const describeName = name => {
        const text = String(name)
        if (text.length > 40) return `一个 ${text.length} 字符的名字`
        return `--${text.replace(/\d{8,}/g, digits => maskDeviceId(digits))}`
    }
    const describeToken = token => `一个 ${[...String(token)].length} 字符的值`
    const values = {}
    for (let index = 0; index < argv.length; index += 1) {
        const token = String(argv[index])
        if (token === '--') {
            // POSIX 的「参数到此为止」：本工具不收位置参数，后面还有东西就只说个数。
            const rest = argv.length - index - 1
            if (rest > 0) throw new Error(`-- 后面还有 ${rest} 个参数，本工具不收位置参数`)
            break
        }
        if (!token.startsWith('--')) {
            throw new Error(`看不懂的参数：${describeToken(token)}（参数写成 --名字 值 或 --名字=值）`)
        }
        const eq = token.indexOf('=')
        const name = eq >= 0 ? token.slice(2, eq) : token.slice(2)
        const inline = eq >= 0 ? token.slice(eq + 1) : null
        if (!BOOL_FLAGS.has(name) && !VALUE_FLAGS.has(name)) throw new Error(`未知参数：${describeName(name)}`)
        // 同一个 flag 给两次时，用哪个全凭出现顺序，读的人看不出——不如当场说。布尔 flag 同样算。
        if (Object.hasOwn(values, name)) throw new Error(`${describeName(name)} 给了两次`)
        if (BOOL_FLAGS.has(name)) {
            if (inline !== null) throw new Error(`--${name} 不带值`)
            values[name] = true
            continue
        }
        let value = inline
        if (value === null) {
            const next = argv[index + 1]
            // 下一个 token 也是个 flag，就当这次没给值：把 `--device` 吞成 `--iid` 的值更糟。
            if (next === undefined || String(next).startsWith('--')) throw new Error(`--${name} 后面没给值`)
            value = String(next)
            index += 1
        }
        if (!value) throw new Error(`--${name} 后面没给值`)
        values[name] = value
    }
    return values
}

let parsedArgs = null
function args() {
    parsedArgs ||= parseArgs(process.argv.slice(2))
    return parsedArgs
}

function argValue(name, fallback = '') {
    return args()[name] ?? fallback
}

/** 曲目号只留末四位：日志和读数可以直接贴进票里，不会反出个人收听记录。 */
export function maskTrackId(trackId) {
    const value = String(trackId || '')
    return value.length <= 4 ? value : `***${value.slice(-4)}`
}

/** 把一次回包收成判定用的读数：去掉曲名与完整曲目号（曲名是个人收听记录）。 */
export function armReadings(rawBody, trackId) {
    const { name, trackId: returnedId, ...rest } = summarizeTrackV2Response(rawBody, trackId)
    return { ...rest, track: maskTrackId(returnedId || trackId) }
}

function rowFrom(base, response, text, context, extra = {}) {
    return {
        ...base,
        ...extra,
        http: response.status,
        bodyBytes: text.length,
        ...armReadings(text, context.trackId),
        ...extractScalars(text),
    }
}

/** 换设备号必然重新 init，而 init 后的头几次签名可能落在短签名窗口里；
 *  每条 arm 先签一次丢掉、只用第二次的那一份，免得把窗口效应读成形状效应。 */
function signWarmedUp(signer, { url, headers }, deviceId) {
    const pairs = Object.fromEntries(headers)
    signer.sign({ url, headers: pairs, deviceId })
    return signer.sign({ url, headers: pairs, deviceId })
}

export async function runArm(arm, context) {
    const base = {
        arm: arm.name,
        expect: arm.expect,
        changes: arm.changes,
    }
    if (arm.request.seo) {
        const url = `${SEO_TRACK}?${encodeSortedParams({ track_id: context.trackId, device_platform: 'web' })}`
        const response = await fetch(url, {
            headers: [['user-agent', WEB_UA]],
            signal: AbortSignal.timeout(context.timeoutMs),
        })
        return rowFrom(base, response, await response.text(), context)
    }

    if (arm.request.me) {
        const spec = buildPcMeRequest({
            identity: buildIdentity(arm.request.identity, { now: Date.now() }),
            app: arm.request.app,
            cookie: arm.request.useCookie ? context.cookie : '',
        })
        const response = await fetch(spec.url, { headers: spec.headers, signal: AbortSignal.timeout(context.timeoutMs) })
        const text = await response.text()
        const payload = safeParse(text) || {}
        // 读数只收标量：`my_info.id`、昵称、头像地址都是个人标识，extractScalars 的
        // 「字符串一律不收 + 键名黑名单」本来就把它们挡在外面。但「有没有解析出用户 id」
        // 这个布尔值是另一回事：匿名回包与登录回包就靠它区分，而它不带出任何标识符。
        return {
            ...base,
            http: response.status,
            bodyBytes: text.length,
            ok: response.status === 200 && Number(payload.status_code) === 0,
            track: null,
            hasUser: Boolean(String(payload?.my_info?.id || '').trim()),
            deviceId: maskDeviceId(spec.params.device_id),
            ...extractScalars(text),
        }
    }

    const seeds = {
        service: context.service,
        captured: context.captured,
    }
    const identity = buildIdentity(arm.request.identity, seeds[arm.request.identity] || {})
    const signDevice = arm.request.signWith === 'other16' ? randomDeviceId() : identity.deviceId
    const spec = buildPcTrackV2Request({
        trackId: context.trackId,
        identity,
        app: arm.request.app,
        localUser: arm.request.localUser,
        cookie: arm.request.useCookie ? context.cookie : '',
    })
    const signed = arm.request.skipSign
        ? { headers: {}, deviceId: identity.deviceId }
        : signWarmedUp(context.signer, spec, signDevice)
    const response = await fetch(spec.url, {
        method: 'POST',
        headers: [...spec.headers, ...Object.entries(signed.headers)],
        body: spec.body,
        signal: AbortSignal.timeout(context.timeoutMs),
    })
    return rowFrom(base, response, await response.text(), context, {
        signed: !arm.request.skipSign,
        deviceId: maskDeviceId(identity.deviceId),
        // 只有 captured 那条带来源：其余 arm 的身份都是本仓库现造的，没有「哪一条」可报。
        ...(arm.request.identity === 'captured' && context.capturedSource ? { identitySource: context.capturedSource } : {}),
        signDeviceId: maskDeviceId(signDevice),
        signedHeaders: Object.keys(signed.headers).length,
        signatureLengths: Object.fromEntries(
            Object.entries(signed.headers).map(([name, value]) => [name.toLowerCase(), String(value).length]),
        ),
    })
}

async function main() {
    const only = argValue('arm')
    const trackId = argValue('track') || process.env.LIBMSSDK_PROBE_TRACK_ID || ''
    const cookieSource = argValue('cookie-from') || (process.env.LIBMSSDK_COOKIE ? 'env' : 'sodam')
    if (args().list) {
        process.stdout.write(`${JSON.stringify(ARMS.map(({ name, expect, changes }) => ({ name, expect, changes })), null, 2)}\n`)
        return
    }
    // 跑几轮必须是 1–100 的整数：下界防 `--repeat 0` 一次不进循环、吐空 verdict；
    // 上界防手滑成 `1e9`——真能跑通的机器上一次就是十二亿条上游请求。
    const repeatArg = argValue('repeat')
    const repeat = repeatArg ? Number(repeatArg) : 1
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
        throw new Error(`--repeat 要给 1 到 100 的整数（收到 ${repeatArg || '(空)'}）`)
    }
    const arms = only ? ARMS.filter(item => item.name === only) : ARMS
    if (!arms.length) throw new Error(`未知 arm：${only}（可选：${ARMS.map(item => item.name).join(' / ')}）`)
    // 先把参数验完，再碰任何凭据与网络：缺身份时要么跳过 captured（跑整份矩阵），
    // 要么直接报错（明确点名了它），不存在「跑到一半才炸」那条路径。
    const captureFile = argValue('from-capture')
    // 两个来源同时给，会拼出一份「谁都不是」的身份：device 取命令行，iid/fp 取文件。
    // 反过来也一样——只给 --iid 或只给 --fp，设备号仍来自文件，那条读数就不再是抓包里那份。
    // 判据不看 --arm：跑 good-ts 时同时给这两个参数，同样是在拼一份没人认领的身份，
    // 只是它这次不进读数而已——参数写错了就该当场说，不该等 arm 决定要不要拦。
    const fromCommandLine = ['device', 'iid', 'fp'].filter(name => argValue(name)).map(name => `--${name}`)
    if (captureFile && fromCommandLine.length) {
        throw new Error(
            `${fromCommandLine.join(' / ')} 与 --from-capture 只能给一个：混出来的那份既不是抓包里的，也不是你手上给的`,
        )
    }
    let capturedFromFile = null
    let capturedProblem = ''
    let capturedShort = ''
    let capturedWhere = ''
    if (captureFile) {
        let text = ''
        try {
            text = fs.readFileSync(captureFile, 'utf8')
        } catch {
            // 不把路径写进错误里：这份日志是要被人贴进票里的，而路径里就带着本机用户名。
            throw new Error('--from-capture 指定的抓包件读不到（路径不打印）')
        }
        try {
            capturedFromFile = captureIdentity(text)
        } catch (error) {
            // 件读得动、但里面那份身份不能用：跟「压根没给身份」同一个后果——
            // 跑整份矩阵就跳过 captured，明确点名了 captured 才当场报错。
            // 以前这里直接抛，件尾一条不齐就把其余 11 条一起拖停。
            // 只降级「数据本身不成立」的错；编程错误（TypeError 之类）没有 short，必须炸出来。
            if (!isKnownCaptureProblem(error)) throw error
            capturedProblem = error.message
            // 转述时只用短原因与坐标：整句塞进括号会变成五层嵌套。
            capturedShort = error.short || error.message
            capturedWhere = error.line ? `第 ${error.line} 行（共 ${error.lineCount} 行）` : ''
        }
    }
    const capturedIdentity = {
        deviceId: argValue('device') || (capturedFromFile || {}).deviceId || '',
        iid: argValue('iid') || (capturedFromFile || {}).iid || '',
        fp: argValue('fp') || (capturedFromFile || {}).fp || '',
    }
    const wantsCaptured = arms.some(item => item.name === 'captured')
    const whyNotCaptured = !wantsCaptured
        ? ''
        : capturedProblem ||
          (capturedIdentity.deviceId ? '' : '这条需要 --from-capture <抓包件>，或直接给 --device <抓包 device_id>')
    if (whyNotCaptured && only) throw new Error(whyNotCaptured)
    const runnable = whyNotCaptured && !only ? arms.filter(item => item.name !== 'captured') : arms
    if (whyNotCaptured && !only) process.stderr.write(`跳过 captured：${whyNotCaptured}（其余 arm 照跑）\n`)
    // 件是给了的，只是这份身份用不了：本次连 captured 都不在跑，也得知会一声。
    if (capturedProblem && !wantsCaptured) {
        const note = capturedWhere
            ? `注意：抓包件里${capturedWhere}${capturedShort}，本次没用它`
            : `注意：抓包件里那份身份用不了（${capturedShort}），本次没用它`
        process.stderr.write(`${note}\n`)
    }
    if (capturedIdentity.deviceId && !capturedFromFile) {
        // 「哪个字段是顶上来的」只有本仓库说得出：上游对身份齐不齐没有信号（真跑实测缺 --fp 照样 200/ok）。
        const missing = ['iid', 'fp'].filter(name => !argValue(name)).map(name => `--${name}`)
        if (missing.length) {
            process.stderr.write(`注意：captured 没给 ${missing.join(' / ')}，会拿 device_id 顶上——那不是一份完整的抓包身份\n`)
        }
    }
    // 这份身份从哪儿来的，得跟着读数走：件里那份要报到第几条（坏行被 #32 拦掉之后
    // 读数会回落到更早的一条，只报「抓包里的」看不出回落），手打那份也不能冒充件里那份。
    const capturedSource = capturedFromFile
        ? {
              from: 'capture',
              line: capturedFromFile.line,
              lineCount: capturedFromFile.lineCount,
              at: capturedFromFile.at,
              blank: capturedFromFile.blank,
              skipped: capturedFromFile.skipped,
              noDevice: capturedFromFile.noDevice,
          }
        : capturedIdentity.deviceId
          ? { from: 'argv' }
          : null
    // account-me 打的是账号自己的档位端点，与曲目无关，所以它不需要 --track。
    if (!trackId && runnable.some(needsTrack)) throw new Error('需要 --track <track_id>（或 --list）')

    const config = loadConfig()
    const explicitSource = argValue('cookie-from')
    let cookie = ''
    try {
        cookie = readCookie(cookieSource)
    } catch {
        // 不打印底层错误：ENOENT 原文里带着本机绝对路径和用户名。
        if (explicitSource) throw new Error('--cookie-from 指定的文件读不到（路径不打印，避免写进日志）')
        process.stderr.write('没读到 cookie（默认源：环境变量 LIBMSSDK_COOKIE 或本机播放器配置）\n')
    }
    if (!cookie) process.stderr.write('警告：带 Cookie 的 arm 会退化成匿名\n')
    const signer = new BdmsSigner({ modulePath: config.bdmsModule, deviceId: config.deviceId })
    const context = {
        trackId,
        cookie,
        timeoutMs: config.requestTimeoutMs,
        service: { deviceId: config.deviceId, iid: config.iid, fp: config.fp },
        captured: capturedIdentity,
        capturedSource,
        signer,
    }

    const breakdown = lineBreakdown(capturedSource || {})
    const sourceNote = !capturedSource
        ? ''
        : capturedSource.from === 'capture'
          ? `抓包身份：件里第 ${capturedSource.line} 行（${breakdown}，at ${capturedSource.at || '未记时间'}）｜`
          : '抓包身份：命令行给的｜'
    process.stderr.write(
        `签名器：${path.basename(config.bdmsModule || '(无)')}｜本机身份：${maskDeviceId(config.deviceId)}｜${sourceNote}` +
            `cookie：${cookie ? `${cookie.split(';').length} 个字段` : '无'}｜曲目：${maskTrackId(trackId)}\n`,
    )
    const rows = []
    for (let round = 0; round < repeat; round += 1) {
        for (const arm of runnable) {
            const row = await runArm(arm, context)
            rows.push({ round: round + 1, ...row })
            process.stdout.write(`${JSON.stringify(row)}\n`)
        }
    }
    const verdict = rows.map(row => ({
        arm: row.arm,
        round: row.round,
        track: row.track,
        http: row.http,
        bytes: row.bodyBytes,
        fullTrack: row.fullTrack ?? null,
        trackSeconds: row.trackDurationSeconds ?? null,
        streamSeconds: row.streamDurationSeconds ?? null,
        gears: (row.gears || []).map(gear => gear.quality || gear.gear).join(','),
        isVip: row['my_info.is_vip'] ?? null,
        hasUser: row.hasUser ?? null,
    }))
    process.stdout.write(`${JSON.stringify({ verdict }, null, 2)}\n`)
    if (!rows.some(row => row.ok)) process.exitCode = 1
}

/**
 * 错误信息里可能带着本机绝对路径（`bdms.node 不存在：D:\Users\…`、
 * `Cannot find module '/app/client/bdms.node'`），而这份日志是要被人贴进票里的。
 * 按空格或按冒号截断都不可靠：路径的每一段都可能带空格（`/soda music/…`、
 * `C:\Users\Jean Dupont\…`），截断点总落在用户名之前。所以逐个 token 判断——
 * 只要这段文字里带着路径分隔符且不是一个孤零零的分隔符，就整段换成占位符。
 * 副作用是把 `src/x/y.rs` 这类相对路径也一并隐掉：宁可多隐，不隐漏。
 * 实测覆盖：带空格用户名的 win 路径、`Program Files`、无冒号的容器路径、盘根
 * `D:\bdms.node`、首段带空格的 posix（`/soda music/…`）、单段 `/bdms.node`、UNC。
 */
const PATHISH = /\S[\\/]\S|\S[\\/]$|^[\\/]\S/

export function safeMessage(error) {
    const text = String(error?.message || error)
    const parts = text.split(/(\s+)/)
    let elided = 0
    const out = parts
        .map(part => {
            if (!PATHISH.test(part) || /^['"`]$/.test(part)) return part
            elided += 1
            return '〈本机路径已省略〉'
        })
        .join('')
    return elided ? out.replace(/〈本机路径已省略〉(\s*〈本机路径已省略〉)+/g, '〈本机路径已省略〉') : text
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        process.stderr.write(`${safeMessage(error)}\n`)
        process.exitCode = 2
    })
}
