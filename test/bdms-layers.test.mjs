import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const probe = path.join(repoRoot, 'verify/wine-multi/bdms-layers.mjs')

const DEVICE = '1730000000042'
// begin 那行只报设备号的位数：完整值与掩码都不出这个文件（约定 7）。
const PROBE_STEPS = [
    'step=begin device=13位',
    'step=load',
    'step=loaded',
    'step=init',
    'step=inited',
    'step=sign',
    'step=signed lines=4',
    'step=done',
]

// 桩模块写在仓库外的临时目录里，文件名只能是 .js：仓库 package.json 带 `"type": "module"`，
// 仓库内的 .js 会被当 ESM；而 .node 会被 require 当原生插件加载。
// 目录名故意带空格与 Program Files——探针的输出里一个字符都不该出现它。
const made = []
function stubDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-layers probe-'))
    const dir = path.join(root, 'Program Files')
    fs.mkdirSync(dir, { recursive: true })
    made.push(root)
    return dir
}

// 自己造的残留自己清：一次跑下来堆七八个临时目录在临时区里不算收尾。
after(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function stub(source) {
    const file = path.join(stubDir(), 'bdms-stub.js')
    fs.writeFileSync(file, source)
    return file
}

// 桩把收到的设备号与 URL 落到自己旁边，测试再读回来。
const okStub = () =>
    stub(
        `const fs = require('node:fs')
module.exports = {
    init(options) { fs.writeFileSync(__dirname + '/init.json', JSON.stringify(options)) },
    generateHttpSignatureHeaders(url, headers) {
        fs.writeFileSync(__dirname + '/sign.json', JSON.stringify({ url, headers }))
        return 'X-Helios\\r\\nabc\\r\\nX-Medusa\\r\\ndef\\r\\n'
    },
}`,
    )

const throwingStub = message =>
    stub(`module.exports = {
    init() { throw new Error(${JSON.stringify(message)}) },
    generateHttpSignatureHeaders() { return '' } }`)

function run(script, args) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    return {
        code: result.status,
        lines: String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean),
        stderr: String(result.stderr || ''),
    }
}

// 七个形状全是编出来的，没有一个指向本机真实目录（开源边界：公开仓库里不许出现本机路径）。
// 它们分别对应 test/entitlement-matrix.test.mjs 那批脱敏形状里的这几类：带空格的用户名、
// Program Files、首段带空格的 posix、无冒号的容器路径、单段 posix 根、盘根、UNC。
const PATH_SHAPES = [
    'D:\\Users\\Jean Dupont\\vendor\\soda-music\\bdms.node',
    'C:\\Program Files\\Soda Music\\resources\\bdms.node',
    '/soda music/vendor/bdms.node',
    '/app/client/bdms.node',
    '/bdms.node',
    'D:\\bdms.node',
    '\\\\srv\\share\\bdms.node',
]

function assertNoPath(text, where) {
    assert.ok(!/[\\/]/.test(text), `${where}里出现了路径分隔符：${text}`)
    assert.ok(!/Jean|Dupont|Program Files|soda music|Users|home|srv|share/i.test(text), `${where}里出现了本机目录或用户名：${text}`)
}

test('三层各自出声：load / init / sign 一行不差', () => {
    const out = run(probe, [okStub(), DEVICE])
    assert.equal(out.code, 0)
    assert.deepEqual(out.lines, PROBE_STEPS)
})

test('begin 那行只报设备号的位数，完整值与掩码都不出现', () => {
    // 第一行的形状已由 PROBE_STEPS 全量断言钉住，这里只管一件事：别把设备号带出来。
    const out = run(probe, [okStub(), DEVICE])
    const text = out.lines.join('\n')
    assert.ok(!text.includes(DEVICE), '完整设备号不该出现在输出里')
    for (const each of [text, out.stderr]) assertNoPath(each, '输出')
})

test('init 与签名拿到的确实是同一个设备号，URL 是探针当场编的', () => {
    const file = okStub()
    run(probe, [file, DEVICE])
    const init = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'init.json'), 'utf8'))
    const sign = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'sign.json'), 'utf8'))
    assert.deepEqual(init, { deviceId: DEVICE })
    assert.match(sign.url, /^https:\/\/api\.qishui\.com\/luna\/pc\/me\?device_id=1730000000042$/)
    assert.equal(sign.headers, 'accept\r\napplication/json\r\n')
})

// 换名字跑也要照样出字：这条测的是「脚本被拷进容器时改了名，于是什么都没发生」——
// #30 里第一次误判就栽在这种「静默不跑」上（当时是入口守卫按文件名匹配）。
test('拷成别的文件名、离开仓库目录也要照跑（一个 docker cp 就能带进容器）', () => {
    const renamed = path.join(stubDir(), 'layers.mjs')
    fs.copyFileSync(probe, renamed)
    const out = run(renamed, [okStub(), DEVICE])
    assert.equal(out.code, 0, out.stderr)
    assert.deepEqual(out.lines, PROBE_STEPS)
})

test('stdout 指向文件也要把八行都落进去（容器里留档用的就是这种形状）', () => {
    const file = okStub()
    const out = path.join(stubDir(), 'out.txt')
    const handle = fs.openSync(out, 'w')
    const result = spawnSync(process.execPath, [probe, file, DEVICE], { stdio: ['ignore', handle, 'ignore'] })
    fs.closeSync(handle)
    assert.equal(result.status, 0)
    assert.deepEqual(fs.readFileSync(out, 'utf8').trim().split(/\r?\n/), PROBE_STEPS)
})

test('导出不符合预期时停在 load，说清缺哪一个', () => {
    const out = run(probe, [stub('module.exports = { init() {} }'), DEVICE])
    assert.equal(out.code, 1)
    assert.deepEqual(out.lines.slice(-2), ['step=load', 'step=failed layer=load reason=exports hasInit=true hasSign=false'])
})

test('路径不存在时报的是类别，七个形状一个都不回声', () => {
    for (const shape of PATH_SHAPES) {
        const out = run(probe, [shape, DEVICE])
        assert.equal(out.code, 1)
        assert.deepEqual(out.lines.slice(-1), ['step=failed layer=load reason=missing 这个路径上没有文件'])
        for (const text of [out.lines.join('\n'), out.stderr]) assertNoPath(text, '输出')
    }
})

test('某一层抛了：报「是抛的不是挂的」，原文一个字都不复述', () => {
    for (const message of [
        'bdms.node 不存在：D:\\Users\\Jean Dupont\\vendor\\soda-music\\bdms.node',
        "Cannot find module 'C:\\Program Files\\Soda Music\\bdms.node'",
        'boom',
    ]) {
        const out = run(probe, [throwingStub(message), DEVICE])
        assert.equal(out.code, 1)
        assert.deepEqual(out.lines.slice(-2), ['step=init', 'step=failed reason=threw name=Error'])
        for (const text of [out.lines.join('\n'), out.stderr]) {
            assertNoPath(text, '输出')
            assert.ok(!text.includes('boom'), `复述了抛出来的原文：${text}`)
        }
    }
})

test('一个路径都不给就说缺参数，不去猜默认值', () => {
    const out = run(probe, [])
    assert.equal(out.code, 1)
    assert.match(out.lines[0], /^step=begin device=\d+位$/)
    assert.deepEqual(out.lines.slice(-1), ['step=failed layer=args reason=missing 把 bdms.node 的路径作为第一个参数传进来'])
})

test('README 的坑 1 与文件表都指着这支探针（少一处就红灯）', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'verify/wine-multi/README.md'), 'utf8')
    // 文件表那一行要整行在：只 grep 文件名的话，开头「一条命令」那段与坑 1 都能替它顶上。
    assert.match(readme, /^\| `bdms-layers\.mjs` \| .*分层探针.*$/m)
    assert.match(readme, /想知道自己那次卡在哪一层就跑 `bdms-layers\.mjs`/)
})

test('加载判据不许两处各自漂：探针与服务认的是同一对导出名', () => {
    // 探针故意不 import 服务那套判据（要能一个 docker cp 单独拷进容器），所以这里用文本钉住同一对名字：
    // src/bdms.mjs 改了导出口径，这条当场红灯，提醒回来看探针那一处。
    const signer = fs.readFileSync(path.join(repoRoot, 'src/bdms.mjs'), 'utf8')
    assert.match(signer, /typeof this\.#module\?\.init !== 'function'/)
    assert.match(signer, /typeof this\.#module\?\.generateHttpSignatureHeaders !== 'function'/)
    const text = fs.readFileSync(probe, 'utf8')
    assert.match(text, /typeof module\?\.init === 'function'/)
    assert.match(text, /typeof module\?\.generateHttpSignatureHeaders === 'function'/)
})
