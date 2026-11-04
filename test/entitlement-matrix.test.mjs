// 离线测试：对照实验的请求形状必须「一次只动一个因素」，否则结论不成立。
// 全部不打网络、不需要真实 bdms.node。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const mockBdms = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mock-bdms.mjs')

const {
    APP_PROFILES,
    ARMS,
    BASELINE,
    armReadings,
    buildIdentity,
    buildPcMeRequest,
    buildPcTrackV2Request,
    captureIdentity,
    encodeSortedParams,
    extractScalars,
    isOffBaseline,
    maskTrackId,
    needsTrack,
    queryEscape,
    runArm,
    safeMessage,
} = await import('../tools/entitlement-matrix.mjs')

const FIXED_NOW = 1789435000000
/** 每种身份形状给一个固定值，避免随机项混进 diff。 */
const IDENTITY_SEEDS = {
    ts: { now: FIXED_NOW },
    rand16: { deviceId: '3000000000000003', iid: '4000000000000004' },
    service: { deviceId: '1000000000000001', iid: '2000000000000002', fp: '1000000000000001' },
    captured: { deviceId: '5000000000000005', iid: '6000000000000006', fp: '5000000000000005' },
}

/** 把一条 arm 落成可比较的形状（设备号用固定值，避免随机项混进 diff）。 */
function shapeOf(arm) {
    const identity = buildIdentity(arm.identity, IDENTITY_SEEDS[arm.identity])
    const spec = buildPcTrackV2Request({
        trackId: '123',
        identity,
        app: arm.app,
        localUser: arm.localUser,
        cookie: arm.useCookie ? 'sessionid_ss=fixed' : '',
    })
    return {
        query: Object.fromEntries(Object.entries(spec.params).map(([k, v]) => [k, String(v)])),
        headers: Object.fromEntries(spec.headers),
        body: spec.body,
    }
}

function diffAgainstBaseline(arm) {
    const base = shapeOf(ARMS.find(item => item.name === BASELINE).request)
    const mine = shapeOf(arm.request)
    const touched = []
    for (const key of new Set([...Object.keys(base.query), ...Object.keys(mine.query)])) {
        if (base.query[key] !== mine.query[key]) touched.push(`query.${key}`)
    }
    for (const key of new Set([...Object.keys(base.headers), ...Object.keys(mine.headers)])) {
        if (base.headers[key] !== mine.headers[key]) touched.push(`header.${key}`)
    }
    if (base.body !== mine.body) touched.push('body')
    return { touched, mine }
}

test('查询参数按字典序拼接，空格转 +（与客户端 Params::encode 同形）', () => {
    assert.equal(queryEscape('Windows 11'), 'Windows+11')
    assert.equal(queryEscape('a~b.c_d-e'), 'a~b.c_d-e')
    assert.equal(queryEscape("!*'()"), '%21%2A%27%28%29')
    assert.equal(encodeSortedParams({ zz: '1', aa: '2', mm: '' }), 'aa=2&mm=&zz=1')
})

test('时间戳身份与客户端回退一致：iid = device_id + 1，fp = device_id', () => {
    const identity = buildIdentity('ts', { now: FIXED_NOW })
    assert.equal(identity.deviceId, '1789435000000')
    assert.equal(identity.iid, '1789435000001')
    assert.equal(identity.fp, identity.deviceId)
    assert.match(buildIdentity('rand16', { deviceId: '1234567890123456' }).deviceId, /^[1-8]\d{15}$/)
})

test('每一条 arm 只改它声明过的字段', () => {
    for (const arm of ARMS.filter(item => !isOffBaseline(item))) {
        const { touched } = diffAgainstBaseline(arm)
        assert.deepEqual(
            touched.slice().sort(),
            arm.touches.slice().sort(),
            `${arm.name} 实际改动 ${touched.join(',') || '（无）'} 与声明 ${arm.touches.join(',') || '（无）'} 不一致`,
        )
    }
})

test('签名失效对照的请求形状与基线逐字节相同（差异只在用哪个设备号签名）', () => {
    const mismatch = ARMS.find(item => item.name === 'sig-mismatch')
    const base = shapeOf(ARMS.find(item => item.name === BASELINE).request)
    assert.deepEqual(shapeOf(mismatch.request), base)
    assert.equal(mismatch.request.signWith, 'other16')
})

test('x-ss-stub 就是 body 的 MD5 大写，且签名设备号来自 URL 同一份身份', () => {
    const spec = buildPcTrackV2Request({
        trackId: '123',
        identity: buildIdentity('ts', { now: FIXED_NOW }),
        app: APP_PROFILES.luna330,
        localUser: '1',
        cookie: 'sessionid_ss=x',
    })
    const stub = spec.headers.find(([name]) => name === 'x-ss-stub')[1]
    assert.equal(stub, crypto.createHash('md5').update(spec.body).digest('hex').toUpperCase())
    assert.equal(new URL(spec.url).searchParams.get('device_id'), String(FIXED_NOW))
    assert.equal(new URL(spec.url).searchParams.get('fp'), String(FIXED_NOW))
})

test('匿名 arm 不带 cookie，其余 arm 都带', () => {
    const without = shapeOf(ARMS.find(item => item.name === 'no-cookie').request)
    const withCookie = shapeOf(ARMS.find(item => item.name === 'good-ts').request)
    assert.equal(without.headers.cookie, undefined)
    assert.equal(withCookie.headers.cookie, 'sessionid_ss=fixed')
})

test('读数只留判定用的标量，绝不外泄播放地址、签名与 cookie', () => {
    const cookie = 'sessionid_ss=SECRET-COOKIE-VALUE'
    const raw = JSON.stringify({
        status_code: 0,
        track: { id: 123, name: '某曲', duration: 236620, preview: { duration: 30001 } },
        track_player: {
            url_player_info: 'https://example.com/play?sign=SECRET-URL-TOKEN',
            video_model: JSON.stringify({ video_duration: 236.62, video_list: [] }),
        },
        cookie,
    })
    const picked = extractScalars(raw)
    const text = JSON.stringify(picked)
    assert.equal(picked.status_code, 0)
    assert.equal(picked['track.duration'], 236620)
    assert.ok(!text.includes('SECRET-COOKIE-VALUE'), 'cookie 值不得出现在读数里')
    assert.ok(!text.includes('SECRET-URL-TOKEN'), '播放地址不得出现在读数里')
    assert.ok(!text.includes('url_player_info'), 'url 字段本身也不该被带出来')
    assert.deepEqual(
        Object.keys(extractScalars(JSON.stringify({ message: '登录提示里可能夹着地址', status_code: 0 }))),
        ['status_code'],
        '字符串型字段一律不收：文案 / 地址 / 标识都可能夹凭据',
    )
})

test('空回包与坏 JSON 都能给出可读判定', () => {
    assert.equal(extractScalars('').status_code, undefined)
    assert.equal(extractScalars('not json').constructor, Object)
})

test('captured 身份必须显式给设备号，缺了就报错而不是悄悄换成别的一份', () => {
    assert.throws(() => buildIdentity('captured', {}), /--device/)
    assert.deepEqual(buildIdentity('captured', { deviceId: '5000000000000005' }), {
        deviceId: '5000000000000005',
        iid: '5000000000000005',
        fp: '5000000000000005',
        shape: 'captured',
    })
})

test('免基线的 arm 只有那两条打别端点的，加一条就要在这里说明为什么', () => {
    assert.deepEqual(
        ARMS.filter(isOffBaseline).map(item => item.name),
        ['seo-web', 'account-me'],
        '这两条整条请求都与基线不同，逐字段不变量对它们不适用',
    )
    assert.deepEqual(
        ARMS.filter(item => !needsTrack(item)).map(item => item.name),
        ['account-me'],
        '只有档位那条与曲目无关，可以不给 --track；其余都得有一首曲子去判',
    )
})

test('抓包件读身份：取最后一份带 device_id 的，坏行跳过，那份不齐就报错，不拿 device_id 顶', () => {
    const line = (item, identity) => JSON.stringify({ at: '2026-11-03T00:00:00.000Z', path: item, identity })
    const good = [
        '{"broken":',
        '',
        line('/luna/pc/playlist', { deviceId: '1111111111111111', iid: '2222222222222', fp: '3333333333333333' }),
        line('/luna/pc/track_v2', { deviceId: '1789435000000', iid: '1789435000001', fp: '1789435000000' }),
        line('/luna/pc/me', { deviceId: '' }),
    ].join('\n')
    assert.deepEqual(captureIdentity(good), {
        deviceId: '1789435000000',
        iid: '1789435000001',
        fp: '1789435000000',
        at: '2026-11-03T00:00:00.000Z',
        line: 4,
        lineCount: 5,
        skipped: 1,
    })
    assert.throws(() => captureIdentity(''), /device_id/)
    assert.throws(() => captureIdentity('{"at":"2026-11-03T00:00:00.000Z","path":"/x"}'), /device_id/)
    // 三个号缺一个就是那份不齐：报错，不顶替，也不回落到更早那一条
    const noFp = line('/luna/pc/track_v2', { deviceId: '1789435000000', iid: '1789435000001', fp: '' })
    const noIid = line('/luna/pc/track_v2', { deviceId: '1789435000000', iid: '', fp: '1789435000000' })
    const neither = line('/luna/pc/track_v2', { deviceId: '1789435000000', iid: '', fp: '' })
    assert.throws(() => captureIdentity(noFp), /不齐/)
    assert.throws(() => captureIdentity(noIid), /不齐/)
    assert.throws(() => captureIdentity(neither), /不齐/)
    assert.throws(() => captureIdentity([line('/luna/pc/playlist', { deviceId: '1111111111111111', iid: '2222222222222', fp: '3333333333333333' }), noFp].join('\n')), /不齐/)
})

test('不齐那条报错要说中是哪一条：第几行、那条 at 何时，并说明为什么不回头用更早那份', () => {
    const row = (at, identity) => JSON.stringify({ at, path: '/luna/pc/track_v2', identity })
    const text = [
        row('2026-11-03T00:00:01.000Z', { deviceId: '1789435000000', iid: '1789435000001', fp: '1789435000000' }),
        row('2026-11-03T00:00:09.000Z', { deviceId: '1789435222222', iid: '1789435222223', fp: '' }),
    ].join('\n')
    // 只说「不齐」，操作者还得自己数文件才知道是哪一条；早先那份是齐的，
    // 不写清楚就会被读成「程序自己挑了一份好的」。
    assert.throws(
        () => captureIdentity(text),
        error => {
            assert.match(error.message, /不齐/)
            assert.match(error.message, /缺 fp/)
            assert.match(error.message, /第 2 行（共 2 行/, `没说是第几行：${error.message}`)
            assert.match(error.message, /2026-11-03T00:00:09\.000Z/, `没带那条的时间：${error.message}`)
            assert.match(error.message, /更早/, `没说不会回头用更早那份：${error.message}`)
            assert.ok(!error.message.includes('1789435222222'), `报错里漏出设备号：${error.message}`)
            return true
        },
    )
})

test('那条「第几行」得活着走到终端：脱敏器不许把它当路径替掉', () => {
    // 报错要经过 main().catch → safeMessage，它把「带斜杠的 token」整段换成占位符。
    // 「第 4/4 行」里的 4/4 正好是这种 token，于是函数里说得再清楚，终端上只剩占位符。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-line-'))
    const capture = path.join(dir, 'capture.jsonl')
    const row = identity => `{"at":"2026-11-03T00:00:01.000Z","path":"/luna/pc/track_v2","identity":${JSON.stringify(identity)}}`
    fs.writeFileSync(
        capture,
        [
            row({ deviceId: '1789435000000', iid: '1789435000001', fp: '1789435000000' }),
            row({ deviceId: '1789435111111', iid: '1789435111112', fp: '1789435111111' }),
            row({ deviceId: '1789435222222', iid: '1789435222223', fp: '' }),
        ].join('\n'),
    )
    const out = runMatrix('--arm', 'captured', '--track', '123', '--from-capture', capture)
    assert.equal(out.status, 2)
    assert.match(out.stderr, /第 3 行（共 3 行/, `终端上没看到第几行：${out.stderr}`)
    assert.ok(!out.stderr.includes('本机路径已省略'), `行号被当路径替掉了：${out.stderr}`)
})

test('不齐的件只跳过 captured，不许把整轮矩阵拖停；明确点名 captured 时才报错', () => {
    // 以前件尾那条不齐 → 整轮在参数校验阶段 exit 2，其余 11 条一条不跑；
    // 而「完全没身份」却只跳过 captured。同一个「captured 跑不了」被分成了两种后果。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-skip-'))
    const capture = path.join(dir, 'capture.jsonl')
    const good = '{"at":"2026-11-03T00:00:01.000Z","path":"/luna/pc/track_v2","identity":{"deviceId":"1789435000000","iid":"1789435000001","fp":"1789435000000"}}'
    const broken = '{"at":"2026-11-03T00:00:09.000Z","path":"/luna/pc/track_v2","identity":{"deviceId":"1789435222222","iid":"1789435222223","fp":""}}'
    fs.writeFileSync(capture, `${good}\n${good}\n${broken}\n`)

    const full = runMatrix('--track', '123', '--from-capture', capture)
    assert.match(full.stderr, /跳过 captured：.*不齐/, `整轮没跳过、直接停了：${full.stderr}`)
    assert.match(full.stderr, /签名器：/, '跳过之后没有继续往下跑其余 arm')

    const onlyCaptured = runMatrix('--arm', 'captured', '--track', '123', '--from-capture', capture)
    assert.equal(onlyCaptured.status, 2)
    assert.match(onlyCaptured.stderr, /不齐/)
    assert.ok(!onlyCaptured.stderr.includes('签名器：'), '点了名还往下走')
})

test('数字身份只在安全整数范围内收：JSON 解析已经把超范围的值改写过了', () => {
    // 16 位设备号本来就压在 2^53 这条线上，而 9007199254740993 解析完就是 …992：
    // 静默差 1，再拿去请求就是「文件里根本没有的那个号」。
    const row = n => `{"at":"2026-11-03T00:00:01.000Z","path":"/luna/pc/track_v2","identity":{"deviceId":${n},"iid":${n},"fp":${n}}}`
    assert.throws(() => captureIdentity(row('9007199254740993')), /2\^53|安全整数/)
    assert.throws(() => captureIdentity(row('9999999999999999')), /2\^53|安全整数/)
    assert.throws(() => captureIdentity(row('1e21')), /2\^53|安全整数/)
    assert.throws(() => captureIdentity(row('0.5')), /整数/)
    // 落在安全范围内的数字照收（JSON 能原样表示，不是改写后的值）
    assert.equal(captureIdentity(row('1789435000000000')).deviceId, '1789435000000000')
})

test('看不懂的参数只报形状：16 位设备号手滑成位置参数，报错不许替人复读一遍', () => {
    // argv 本来就会进 shell 历史与进程列表，是这条链路唯一的泄漏点；报错还要再复读一遍，
    // 而这份报错正是要贴进票里的。拼错的 flag 仍要点名，不然没法改。
    const asValue = runMatrix('--arm', 'captured', '1789435999999999')
    assert.ok(!asValue.stderr.includes('1789435999999999'), `报错把号复读了：${asValue.stderr}`)
    assert.match(asValue.stderr, /看不懂的参数/)

    const asFlag = runMatrix('--1789435999999999')
    assert.ok(!asFlag.stderr.includes('1789435999999999'), `报错把号当 flag 复读了：${asFlag.stderr}`)
    assert.match(asFlag.stderr, /未知参数/)

    const typo = runMatrix('--arrm', 'captured')
    assert.match(typo.stderr, /--arrm/, '拼错的 flag 还是要点名')
})

test('--repeat 还要有上限：十亿轮手滑就是十亿次上游请求', () => {
    // 在一台真能跑通的机器上（真模块 + 真 cookie），上限就是「会不会把服务器打封」那条线。
    for (const bad of ['1000', '1e9', '999999999999']) {
        const out = runMatrix(
            '--arm', 'captured', '--track', '123',
            '--device', '1730000000099', '--iid', '1730000000100', '--fp', '1730000000101',
            '--repeat', bad,
        )
        assert.equal(out.status, 2, `--repeat ${bad} 没被拒（exit ${out.status}）`)
        assert.match(out.stderr, /--repeat .*1 到 100/, `报错没说上限：${out.stderr}`)
        assert.ok(!out.stderr.includes('签名器：'), `超上限还往下走：${out.stderr}`)
    }
    // 上限内照走：停在「拿不到模块」那一步，说明参数校验放行了
    const ok = runMatrix('--arm', 'captured', '--track', '123', '--device', '1730000000099', '--iid', '1730000000100', '--fp', '1730000000101', '--repeat', '2')
    assert.match(ok.stderr, /签名器：/, `上限内的值被误杀：${ok.stderr}`)
})

test('布尔 flag 也不能重复：--list --list 不许静默收下', () => {
    // 「重复一律当场报错」这句得对两种 flag 都成立，否则脚本拼参数时看不出自己拼了两遍。
    const out = runMatrix('--list', '--list')
    assert.equal(out.status, 2)
    assert.match(out.stderr, /--list 给了两次/, `重复的 --list 被放过了：${out.stdout.slice(0, 40)}`)
})

test('裸 -- 按「参数到此为止」处理：后面还有东西就只说个数，不复读', () => {
    // POSIX 惯例；本工具不收位置参数，所以后面还有东西仍要报错，但别把号再复读一遍。
    const after = runMatrix('--arm', 'captured', '--', '1789435999999999')
    assert.equal(after.status, 2)
    assert.match(after.stderr, /-- 后面还有 1 个参数/, `裸 -- 没按惯例处理：${after.stderr}`)
    assert.ok(!after.stderr.includes('1789435999999999'), `报错复读了后面的值：${after.stderr}`)
    const trailing = runMatrix('--list', '--')
    assert.equal(trailing.status, 0, `结尾的裸 -- 不该报错：${trailing.stderr}`)
    assert.ok(Array.isArray(JSON.parse(trailing.stdout)))
})

test('手打身份里哪个字段是顶上来的都要说出来：只给 --device 与 --iid 也照样提醒', () => {
    // 上游对这份身份没有信号（真跑实测 200/ok），所以「顶上」这件事只能由本仓库自己说。
    const onlyTwo = runMatrix('--arm', 'captured', '--track', '123', '--device', '1730000000099', '--iid', '1730000000100')
    assert.match(onlyTwo.stderr, /没给 --fp/, `缺 fp 却没出声：${onlyTwo.stderr}`)
    assert.match(onlyTwo.stderr, /顶上/)
    assert.equal(onlyTwo.status, 2, '提醒归提醒，用例照旧该停在「没有模块」那一步，不去碰网络')
    const onlyOne = runMatrix('--arm', 'captured', '--track', '123', '--device', '1730000000099')
    assert.match(onlyOne.stderr, /没给 --iid \/ --fp/, '两个都缺时仍要说，且说清缺的是哪两个')
    const allThree = runMatrix('--arm', 'captured', '--track', '123', '--device', '1730000000099', '--iid', '1730000000100', '--fp', '1730000000101')
    assert.ok(!/顶上/.test(allThree.stderr), `三个号都给全了还被提醒：${allThree.stderr}`)
})

test('跑 CLI 用例时真模块进不来：外层塞一份能加载的，也不许被拿去签名', () => {
    // 这条是给文件头「全部不打网络、不需要真实 bdms.node」站的岗。
    // 提醒打完之后参数校验就算过了，代码接着 loadConfig()：显式给的模块路径不查存在性
    // （src/config.mjs:66 原样返回），所以外面漏进来的 env 会被直接采用——机器上放着真的
    // bdms.node 也一样会被找到，然后 runArm 真的去打官方接口。CI 里恰好没模块，看不见这件事。
    // 判据：这里从外层塞一份「能加载」的 mock，runMatrix 没把自己钉死的话，
    // 它的文件名就会出现在读数里，并且真的发出去一条请求。
    const previous = process.env.LIBMSSDK_BDMS_MODULE
    const previousTimeout = process.env.LIBMSSDK_UPSTREAM_TIMEOUT_MS
    process.env.LIBMSSDK_BDMS_MODULE = mockBdms
    // 红的时候这条会真的走到 fetch：超时压到 1 毫秒，请求出不了门，判据不受影响。
    process.env.LIBMSSDK_UPSTREAM_TIMEOUT_MS = '1'
    try {
        const out = runMatrix('--arm', 'captured', '--track', '123', '--device', '1730000000099')
        assert.ok(!out.stderr.includes('mock-bdms'), `用了外面那份能加载的模块：${out.stderr}`)
        assert.ok(!out.stdout.includes('"arm"'), `居然拿到了回包，说明请求发出去了：${out.stdout}`)
        assert.equal(out.status, 2, '该停在拿不到模块那一步，而不是跑完')
    } finally {
        if (previous === undefined) delete process.env.LIBMSSDK_BDMS_MODULE
        else process.env.LIBMSSDK_BDMS_MODULE = previous
        if (previousTimeout === undefined) delete process.env.LIBMSSDK_UPSTREAM_TIMEOUT_MS
        else process.env.LIBMSSDK_UPSTREAM_TIMEOUT_MS = previousTimeout
    }
})

test('line 与 lineCount 都按物理行算：空行也占一个号，所以 lineCount 报不出件里有几条记录', () => {
    const row = '{"at":"2026-11-03T00:00:00.000Z","path":"/luna/pc/track_v2","identity":{"deviceId":"1789435000000","iid":"1789435000001","fp":"1789435000000"}}'
    assert.deepEqual(captureIdentity(`${row}\n`), {
        deviceId: '1789435000000',
        iid: '1789435000001',
        fp: '1789435000000',
        at: '2026-11-03T00:00:00.000Z',
        line: 1,
        lineCount: 1,
        skipped: 0,
    })
    const two = captureIdentity(`${row}\n${row}\n`)
    assert.equal(two.line, 2, '取的是最后一份')
    assert.equal(two.lineCount, 2, '两条记录就是两行')
    // 件尾多一个空行，报的就不是「两条记录」而是「文件有两行」：读数是第几行/共几行这一对，
    // 两边同一口径，能直接翻到那一行去核。改成记录数反而和 line 对不上。
    const withBlank = captureIdentity(`${row}\n\n`)
    assert.equal(withBlank.lineCount, 2, '空行也占一个号')
    assert.equal(withBlank.line, 1, '取到的还是那一条')
})

test('件首带 BOM 不许吞掉第一条；读不懂的行要数出来', () => {
    // 记事本另存就会加 BOM。以前第 1 行 JSON.parse 失败被当成坏行跳过，
    // 只有一条记录的文件会直接报「没有带 device_id 的记录」——文件明明有。
    const row = '{"at":"2026-11-03T00:00:00.000Z","path":"/luna/pc/track_v2","identity":{"deviceId":"1789435000000","iid":"1789435000001","fp":"1789435000000"}}'
    const withBom = captureIdentity(`\uFEFF${row}\n`)
    assert.equal(withBom.deviceId, '1789435000000')
    assert.equal(withBom.line, 1)
    assert.equal(withBom.lineCount, 1)
    assert.equal(withBom.skipped, 0, '好东西不算坏行')
    const junk = captureIdentity(`\uFEFF${row}\n{"broken":\n${row}\n`)
    assert.equal(junk.line, 3)
    assert.equal(junk.skipped, 1, '半个 JSON 要数出来，别悄悄吞掉')
})

test('件里的 at 只在像 ISO 时间时才露出来：转义序列与长标识符不许进终端和读数', () => {
    // at 是件里的原文，之前不经任何判据就进启动行、报错与 row。写一份带转义序列的：
    // 一个完整标识符 + 终端控制字符都原样出去，等于绕开了本仓库的脱敏口径（设备号全走 maskDeviceId）。
    const row = at => JSON.stringify({ at, path: '/luna/pc/track_v2', identity: { deviceId: '1789435000000', iid: '1789435000001', fp: '1789435000000' } })
    const evil = '1789435999999 \u001b[31mLEAKME\u001b[0m'
    assert.equal(captureIdentity(`${row(evil)}\n`).at, '', '不像时间的 at 不该原样回出来')
    assert.equal(captureIdentity(`${row('2026-11-03T00:00:01.000Z')}\n`).at, '2026-11-03T00:00:01.000Z')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-at-'))
    const capture = path.join(dir, 'capture.jsonl')
    fs.writeFileSync(capture, `${row(evil)}\n`)
    const out = runMatrix('--arm', 'captured', '--track', '123', '--from-capture', capture)
    assert.ok(!out.stderr.includes('\u001b'), `终端控制字符漏出去了：${JSON.stringify(out.stderr)}`)
    assert.ok(!out.stderr.includes('LEAKME'), `at 里的标识符原样打出来了：${out.stderr}`)
    assert.match(out.stderr, /未记时间/, `没说明 at 不可用：${out.stderr}`)
})

test('身份字段不是字符串或数字就拒：别把 [object Object] 当设备号发出去', () => {
    // 读取侧的责任是「不自己编」：`String({})` 出来的 `[object Object]` 就是工具自己编的值，
    // 而启动行还会自信地报「件里第 1 行」——比顶替更糟，因为那玩意儿会真的进请求。
    const row = identity => JSON.stringify({ at: '2026-11-03T00:00:00.000Z', path: '/luna/pc/track_v2', identity })
    assert.throws(() => captureIdentity(row({ deviceId: { a: 1 }, iid: '2', fp: '3' })), /identity\.deviceId 是对象/)
    assert.throws(() => captureIdentity(row({ deviceId: '1', iid: [2], fp: '3' })), /identity\.iid 是数组/)
    assert.throws(() => captureIdentity(row({ deviceId: '1', iid: '2', fp: true })), /identity\.fp 是布尔值/)
    // 件里没引号时数字就是数字：这条是合法写法，不许误杀
    const numeric = captureIdentity(row({ deviceId: 1789435000000, iid: 1789435000001, fp: 1789435000000 }))
    assert.equal(numeric.deviceId, '1789435000000')
    assert.equal(numeric.iid, '1789435000001')

    // 走一遍 CLI：报错要能在终端看见，且 stdout 里不许出现编出来的值
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-type-'))
    const capture = path.join(dir, 'capture.jsonl')
    fs.writeFileSync(capture, `${row({ deviceId: { a: 1 }, iid: '2', fp: '3' })}\n`)
    const out = runMatrix('--arm', 'captured', '--track', '123', '--from-capture', capture)
    assert.equal(out.status, 2)
    assert.match(out.stderr, /identity\.deviceId 是对象/)
    assert.ok(!out.stdout.includes('[object Object]'), `编出来的值进了读数：${out.stdout}`)
    assert.ok(!out.stderr.includes('签名器：'), `报错后还在往下走：${out.stderr}`)
})

test('--repeat 不是正整数就当场报错，别跑出一份空的 verdict', () => {
    // 以前 `--repeat abc` / `--repeat 0` → rounds 循环一次都不进 → `{"verdict": []}` + exit 1，
    // 读起来像「每条 arm 都失败了」，实际是一条都没跑。
    for (const bad of ['abc', '0', '-2', '1.5']) {
        const out = runMatrix(
            '--arm', 'captured', '--track', '123',
            '--device', '1730000000099', '--iid', '1730000000100', '--fp', '1730000000101',
            '--repeat', bad,
        )
        assert.equal(out.status, 2, `--repeat ${bad} 没被拒（exit ${out.status}）：${out.stdout.slice(0, 200)}`)
        assert.match(out.stderr, /--repeat/, `报错没点名 --repeat：${out.stderr}`)
        assert.ok(!out.stdout.includes('verdict'), `还在往外吐空 verdict：${out.stdout}`)
    }
})

test('账号档位那条走 GET /luna/pc/me：没有请求体，也就不发 content-type 与 x-ss-stub', () => {
    const identity = buildIdentity('ts', { now: FIXED_NOW })
    const spec = buildPcMeRequest({ identity, app: APP_PROFILES.luna330, cookie: 'sessionid_ss=fixed' })
    const names = spec.headers.map(([name]) => name)
    assert.ok(!names.includes('content-type'), 'GET 没有请求体，不该带 content-type')
    assert.ok(!names.includes('x-ss-stub'), '没有 body 就没有 MD5 桩，带了就和客户端不一样')
    assert.equal(spec.body, '')
    assert.equal(new URL(spec.url).pathname, '/luna/pc/me')
    assert.equal(spec.params.device_id, String(FIXED_NOW))
    const url = new URL(spec.url)
    assert.equal(decodeURIComponent(url.search.replace(/^\?/, '').split('&')[0]), `ac=wifi`)
    assert.deepEqual(names, [
        'user-agent',
        'x-luna-background-type',
        'x-luna-is-background-req',
        'x-luna-is-local-user',
        'cookie',
    ])
    assert.equal(
        buildPcMeRequest({ identity, app: APP_PROFILES.luna330 }).headers.some(([name]) => name === 'cookie'),
        false,
        '不带 cookie 时就不要发这个头',
    )
})

const matrixCli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'entitlement-matrix.mjs')
/**
 * 跑一次矩阵命令行。这里必须把模块路径钉到一个不存在的位置：
 * 参数校验之后就是 loadConfig()，而显式给的模块路径不查存在性——外面漏进来的 env 会被原样采用，
 * 机器上放着真的 bdms.node 时它照样被找到，接着 runArm 直接 fetch 官方接口。
 * 离线约定不能靠「这台机器恰好没装模块」成立。不签名的 arm（seo 那条）拿到模块也用不上，
 * 所以再压一道超时：真发出去也只会立刻断掉，拿不回任何读数。
 */
function runMatrix(...args) {
    return spawnSync(process.execPath, [matrixCli, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            LIBMSSDK_COOKIE: 'sessionid_ss=test',
            LIBMSSDK_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-matrix-')),
            // 目录名要不可预测：固定名字的共享路径上，别人可以预先放一个 bdms.node 等着被加载。
            LIBMSSDK_BDMS_MODULE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-matrix-guard-')), 'bdms.node'),
            LIBMSSDK_UPSTREAM_TIMEOUT_MS: '1',
        },
    })
}

test('档位那条的读数：hasUser 与 status_code 各管一件事，个人标识一律不进读数', async () => {
    // 两份固定回包：登录回包与匿名回包的形状（stub，不打网络）。
    const loggedIn = JSON.stringify({
        status_code: 0,
        status_info: { status_msg: '某句可能夹着地址的提示文案' },
        my_info: { id: '7000000000000', nickname: '私人昵称', larger_avatar_url: { uri: 'https://example/a.jpg' }, is_vip: false },
    })
    const anonymous = '{"status_code":1000016,"status_info":{},"my_info":{}}'
    const bodies = [loggedIn, anonymous]
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response(bodies.shift())
    try {
        const arm = ARMS.find(item => item.name === 'account-me')
        const context = { trackId: '', cookie: 'sessionid_ss=SECRET-COOKIE', timeoutMs: 5000, service: {}, captured: {} }
        const withCookie = await runArm(arm, context)
        const withoutCookie = await runArm(arm, { ...context, cookie: '' })
        assert.equal(withCookie.ok, true)
        assert.equal(withCookie.hasUser, true, '带 Cookie 的回包认得出这是登录态')
        assert.equal(withCookie['my_info.is_vip'], false)
        assert.equal(withoutCookie.ok, false, '匿名回包 status_code 非 0，不能算成同一条读数')
        assert.equal(withoutCookie.hasUser, false, '匿名回包没有用户 id——这正是归因的依据')
        const text = JSON.stringify([withCookie, withoutCookie])
        assert.ok(!text.includes('7000000000000'), '用户 id 不得进读数')
        assert.ok(!text.includes('私人昵称'), '昵称不得进读数')
        assert.ok(!text.includes('SECRET-COOKIE'), 'cookie 不得进读数')
        assert.ok(!text.includes('example'), `头像地址不得进读数：${text}`)
    } finally {
        globalThis.fetch = original
    }
})

test('抓包件读不到、或里面没有身份：都在碰凭据之前停下，且不说出本机路径', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-capture-'))
    const missing = path.join(dir, 'nope.jsonl')
    const noIdentity = path.join(dir, 'capture.jsonl')
    fs.writeFileSync(noIdentity, '{"at":"2026-11-03T00:00:00.000Z","path":"/luna/pc/me","identity":{"deviceId":""}}\n')
    const argv = ['--track', '123', '--arm', 'captured', '--from-capture']

    const unreadable = runMatrix(...argv, missing)
    assert.notEqual(unreadable.status, 0)
    assert.match(unreadable.stderr, /读不到/)
    assert.ok(!unreadable.stderr.includes(missing), `报错里漏出了抓包件路径：${unreadable.stderr}`)

    const empty = runMatrix(...argv, noIdentity)
    assert.notEqual(empty.status, 0)
    assert.match(empty.stderr, /没有带 device_id/)
})

test('命令行给的号与 --from-capture 只能给一个，报错点名实际撞的那几个，且发生在碰凭据之前', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-mixed-'))
    const capture = path.join(dir, 'capture.jsonl')
    fs.writeFileSync(
        capture,
        '{"at":"2026-11-03T00:00:00.000Z","path":"/luna/pc/track_v2","identity":{"deviceId":"1789435000000","iid":"1789435000001","fp":"1789435000000"}}\n',
    )
    // 只给一个号时，报错不许把另外两个也一并点进去：那才是「看不出到底撞了哪个」。
    const check = (extra, given, notGiven) => {
        const out = runMatrix('--arm', 'captured', '--track', '123', '--from-capture', capture, ...extra)
        assert.notEqual(out.status, 0, `${extra[0] || '--device'} 与 --from-capture 同时给竟然走通了`)
        assert.match(out.stderr, /只能给一个/)
        for (const name of given) assert.ok(out.stderr.includes(name), `报错没点名 ${name}：${out.stderr}`)
        for (const name of notGiven) assert.ok(!out.stderr.includes(name), `报错点了一个没给的 ${name}：${out.stderr}`)
        assert.ok(!out.stderr.includes('签名器：'), `报错后还在往下走：${out.stderr}`)
    }
    check(['--device', '1730000000099'], ['--device'], ['--iid', '--fp'])
    check(['--iid', '1730000000088'], ['--iid'], ['--device', '--fp'])
    check(['--fp', '1730000000077'], ['--fp'], ['--device', '--iid'])
    check(['--iid', '1730000000088', '--fp', '1730000000077'], ['--iid', '--fp'], ['--device'])
    // 只给其中一种来源的，照旧能走完参数校验（这条守住了互斥没误杀合法用法）
    const fileOnly = runMatrix('--arm', 'captured', '--track', '123', '--from-capture', path.join(dir, 'nope.jsonl'))
    assert.match(fileOnly.stderr, /读不到/, '只给 --from-capture 仍走原来那条报错')
})

test('参数写法收紧：--名字=值 也认，缺值 / 重复 / 未知 / 多余 token 一律当场报错', () => {
    // 以前 argValue 只做 indexOf('--名字')：`--from-capture=<件>` 是 -1，互斥判据整条被绕过，
    // 件被完全忽略、身份静默换成命令行那份；`--arm=captured` 还会悄悄变成跑整矩阵。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-args-'))
    const capture = path.join(dir, 'capture.jsonl')
    fs.writeFileSync(
        capture,
        '{"at":"2026-11-03T00:00:00.000Z","path":"/luna/pc/track_v2","identity":{"deviceId":"1789435000000","iid":"1789435000001","fp":"1789435000000"}}\n',
    )

    const equals = runMatrix('--arm=captured', '--track=123', `--from-capture=${capture}`, '--device=1730000000099')
    assert.equal(equals.status, 2, `--名字=值 没被解析：${equals.stderr}`)
    assert.match(equals.stderr, /只能给一个/, `= 写法绕过了互斥：${equals.stderr}`)
    assert.match(equals.stderr, /--device/)

    // --arm=captured 要真的只跑 captured：没身份就该报错，而不是悄悄跑整矩阵
    const onlyCaptured = runMatrix('--arm=captured', '--track', '123')
    assert.match(onlyCaptured.stderr, /需要 --from-capture/, `--arm= 写法没生效：${onlyCaptured.stderr}`)

    const missing = runMatrix('--arm', 'captured', '--track', '123', '--from-capture')
    assert.match(missing.stderr, /--from-capture 后面没给值/, `缺值没报：${missing.stderr}`)

    const duplicate = runMatrix('--arm', 'captured', '--track', '123', '--track', '456')
    assert.match(duplicate.stderr, /--track 给了两次/, `重复没报：${duplicate.stderr}`)

    const unknown = runMatrix('--arrm', 'captured')
    assert.match(unknown.stderr, /未知参数：--arrm/, `未知参数没报：${unknown.stderr}`)

    // 值的位置上是另一个 flag：以前会把 --device 当 iid 的值吞掉
    const swallowed = runMatrix('--arm', 'captured', '--track', '123', '--iid', '--device', '1730000000099')
    assert.match(swallowed.stderr, /--iid 后面没给值/, `吞值没报：${swallowed.stderr}`)

    const stray = runMatrix('captured')
    assert.match(stray.stderr, /看不懂的参数/, `多余 token 没报：${stray.stderr}`)

    // --list 照旧：不碰凭据、不读配置
    const list = runMatrix('--list')
    assert.equal(list.status, 0)
    assert.ok(Array.isArray(JSON.parse(list.stdout)), `--list 的输出坏了：${list.stdout.slice(0, 80)}`)
})

test('报错信息里的路径整段隐掉，带空格的用户名/目录也算 (#10 日志要能贴进票里)', () => {
    const leaks = [
        'bdms.node 不存在：D:\\Users\\Jean Dupont\\vendor\\soda-music\\bdms.node',
        'bdms.node 不存在：C:\\Program Files\\Soda Music\\resources\\app.asar.unpacked\\bdms.node',
        'bdms.node 不存在：D:/Users/Jean/nope/bdms.node',
        'bdms.node 不存在：D:\\bdms.node',
        'bdms.node 不存在：/soda music/vendor/bdms.node',
        'bdms.node 不存在：/bdms.node',
        'bdms.node 不存在：\\\\srv\\share\\bdms.node',
        "Cannot find module '/app/client/bdms.node'",
        "Cannot find module '/wine/jean dupont/x/bdms.node'",
    ]
    for (const message of leaks) {
        const out = safeMessage(new Error(message))
        assert.ok(!/[\\/]/.test(out), `分隔符漏出来：${out}`)
        assert.ok(!/Jean|Dupont|Program Files|soda music|Users|wine|home/i.test(out), `本机目录或用户名漏出来：${out}`)
        assert.match(out, /本机路径已省略/)
    }
    const clean = [
        '未找到 bdms.node：请设置 LIBMSSDK_CLIENT_DIR',
        'captured 需要 --device <抓包 device_id>',
        '跑整份矩阵时跳过 captured（可选：env / sodam / 文件路径）',
        '未知 arm: seo（可选：good-ts / rand16）',
    ]
    for (const message of clean) assert.equal(safeMessage(new Error(message)), message)
})

test('读数不带曲名与完整曲目号，所以日志可以直接贴进票里', () => {
    const row = armReadings(
        JSON.stringify({
            track: { id: '7000000000000000001', name: '某首私人歌单里的歌', duration: 185262 },
            track_player: {
                video_model: JSON.stringify({ video_duration: 185.309, video_list: [] }),
            },
        }),
        '7000000000000000001',
    )
    const text = JSON.stringify(row)
    assert.equal(row.fullTrack, true)
    assert.equal(row.track, '***0001')
    assert.ok(!text.includes('7000000000000000001'), '完整曲目号不该出现在读数里')
    assert.ok(!text.includes('某首私人歌单里的歌'), '曲名不该出现在读数里')
    assert.equal(maskTrackId('123'), '123')
})

test('CLI 直接跑 captured 而不给身份时，报错要说清缺什么（不起网络）', () => {
    const result = runMatrix('--track', '123', '--arm', 'captured')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--device/)
})

test('读数用的是件里哪一条，启动行就得写出来：手打的那份也要说明来源', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-source-'))
    const capture = path.join(dir, 'capture.jsonl')
    const record = (at, deviceId) =>
        `{"at":"${at}","path":"/luna/pc/track_v2","identity":{"deviceId":"${deviceId}","iid":"${deviceId}","fp":"${deviceId}"}}`
    // 中间夹一条读不懂的行：行号按物理行算，所以选中的是第 3 行；跳过几条也要说，
    // 否则「共 3 行」和「件里只有 2 条记录」对不上，看的人以为是文件坏了。
    fs.writeFileSync(capture, `${record('2026-11-03T00:00:01.000Z', '1789435000000')}\n{"broken":\n${record('2026-11-03T00:00:02.000Z', '1789435111111')}\n`)

    const fromFile = runMatrix('--arm', 'captured', '--track', '123', '--from-capture', capture)
    assert.match(fromFile.stderr, /件里第 3 行（共 3 行/, `启动行没报是第几行：${fromFile.stderr}`)
    assert.match(fromFile.stderr, /跳过 1 条/, `跳过的坏行没报数：${fromFile.stderr}`)
    assert.match(fromFile.stderr, /2026-11-03T00:00:02\.000Z/, `启动行没报那条的时间：${fromFile.stderr}`)
    assert.ok(!fromFile.stderr.includes('1789435111111'), `启动行漏出完整设备号：${fromFile.stderr}`)

    // 顶替那件事已经由 #32 那道门拦住了，但「这条读数来自命令行还是来自件里」还是得看得见
    const fromArgv = runMatrix('--arm', 'captured', '--track', '123', '--device', '1730000000099', '--iid', '1730000000100', '--fp', '1730000000101')
    assert.match(fromArgv.stderr, /命令行给的/, `手打那份没标来源：${fromArgv.stderr}`)
})

test('真实那条路径（stub fetch，不打网络）：签名头在最后、读数脱敏到底', async () => {
    const { BdmsSigner } = await import('../src/bdms.mjs')
    const context = {
        trackId: '7000000000000000001',
        cookie: 'sessionid_ss=SECRET-COOKIE',
        timeoutMs: 5000,
        service: { deviceId: '1000000000000001', iid: '2000000000000002', fp: '1000000000000001' },
        captured: { deviceId: '5000000000000005', iid: '6000000000000006', fp: '5000000000000005' },
        capturedSource: { from: 'capture', line: 4, lineCount: 7, at: '2026-11-03T00:00:07.000Z' },
    }
    context.signer = new BdmsSigner({ modulePath: mockBdms, deviceId: context.service.deviceId })
    const payload = JSON.stringify({
        track: { id: '7000000000000000001', name: '私人曲目名', duration: 185262 },
        track_player: {
            url_player_info: 'https://example.com/play?sign=SECRET-URL',
            video_model: JSON.stringify({
                video_duration: 185.309,
                video_list: [{ gear_des_key: '0:MP4|5:lossless', video_meta: { quality: 'lossless', bitrate: 1572199, size: 36408802 } }],
            }),
        },
    })
    const seen = []
    const original = globalThis.fetch
    globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), headers: init.headers })
        return new Response(payload)
    }
    try {
        const row = await runArm(ARMS.find(item => item.name === 'captured'), context)
        assert.equal(row.fullTrack, true)
        assert.equal(row.deviceId, '500***005')
        assert.equal(row.track, '***0001')
        assert.deepEqual(row.identitySource, { from: 'capture', line: 4, lineCount: 7, at: '2026-11-03T00:00:07.000Z' }, '读数里要能看出这份身份是件里哪一条')
        const reading = JSON.stringify(row)
        assert.ok(!reading.includes('SECRET-COOKIE'), 'cookie 不得进读数')
        assert.ok(!reading.includes('SECRET-URL'), '播放地址不得进读数')
        assert.ok(!reading.includes('私人曲目名'), '曲名不得进读数')
        assert.ok(!reading.includes('7000000000000000001'), '完整曲目号不得进读数')
        assert.deepEqual(seen[0].headers.slice(-2).map(([name]) => name), ['X-Helios', 'X-Medusa'])
        assert.ok(seen[0].url.includes('device_id=5000000000000005'), 'captured 用的必须是传进来的那份设备号')
    } finally {
        globalThis.fetch = original
    }
})
