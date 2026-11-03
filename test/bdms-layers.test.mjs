import { test } from 'node:test'
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
function stubDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-layers probe-'))
    const dir = path.join(root, 'Program Files')
    fs.mkdirSync(dir, { recursive: true })
    return dir
}

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

// 这批路径形状与 test/entitlement-matrix.test.mjs 盯的是同一套：带空格的用户名、Program Files、
// 无冒号的容器路径、盘根、首段带空格的 posix、单段路径、UNC。探针把它们全挡在输出之外。
const PATH_SHAPES = [
    'D:\\Users\\Jean Dupont\\vendor\\soda-music\\bdms.node',
    'C:\\Program Files\\Soda Music\\resources\\bdms.node',
    '/soda music/vendor/bdms.node',
    '/bdms.node',
    '\\\\srv\\share\\bdms.node',
    'D:\\Aworker\\libmssdk\\vendor\\soda-music\\没有这个.node',
]

function assertNoPath(text, where) {
    assert.ok(!/[\\/]/.test(text), `${where}里出现了路径分隔符：${text}`)
    assert.ok(!/Jean|Dupont|Program Files|soda music|Users|Aworker|wine|home/i.test(text), `${where}里出现了本机目录或用户名：${text}`)
}

test('三层各自出声：load / init / sign 一行不差', () => {
    const out = run(probe, [okStub(), DEVICE])
    assert.equal(out.code, 0)
    assert.deepEqual(out.lines, PROBE_STEPS)
})

test('begin 只报设备号的位数，完整值与掩码都不出现', () => {
    const out = run(probe, [okStub(), DEVICE])
    assert.equal(out.lines[0], 'step=begin device=13位')
    for (const text of [out.lines.join('\n'), out.stderr]) assertNoPath(text, '输出')
    assert.ok(!out.lines.join('\n').includes(DEVICE), '完整设备号不该出现在输出里')
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

test('路径不存在时报的是类别，六种路径形状一种都不回声', () => {
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

test('探针同时出现在 README 的坑条目与文件表里', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'verify/wine-multi/README.md'), 'utf8')
    assert.match(readme, /bdms-layers\.mjs/)
    assert.match(readme, /分层探针/)
})
