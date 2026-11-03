import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const probe = path.join(repoRoot, 'verify/wine-multi/bdms-layers.mjs')
const PROBE_STEPS = ['begin', 'load', 'loaded', 'init', 'inited', 'sign', 'signed lines=4', 'done'].map(text => `step=${text}`)

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

function run(script = probe, args = []) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    return { code: result.status, lines: String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean), stderr: String(result.stderr || '') }
}

test('三层各自出声：load / init / sign 一行不差', () => {
    const out = run(probe, [okStub(), '1730000000000'])
    assert.equal(out.code, 0)
    assert.deepEqual(out.lines, PROBE_STEPS)
})

test('init 与签名拿到的确实是同一个设备号，URL 是探针当场编的', () => {
    const file = okStub()
    run(probe, [file, '1730000000042'])
    const init = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'init.json'), 'utf8'))
    const sign = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'sign.json'), 'utf8'))
    assert.deepEqual(init, { deviceId: '1730000000042' })
    assert.match(sign.url, /^https:\/\/api\.qishui\.com\/luna\/pc\/me\?device_id=1730000000042$/)
    assert.equal(sign.headers, 'accept\r\napplication/json\r\n')
})

// 换名字跑也要照样出字：这条测的是「脚本被拷进容器时改了名，于是什么都没发生」——
// #30 里第一次误判就栽在这种「静默不跑」上（当时是入口守卫按文件名匹配）。
test('探针被拷成别的文件名也要照跑，不许静默什么都不做', () => {
    const renamed = path.join(stubDir(), 'layers.mjs')
    fs.copyFileSync(probe, renamed)
    const out = run(renamed, [okStub(), '1730000000000'])
    assert.equal(out.code, 0)
    assert.deepEqual(out.lines, PROBE_STEPS)
})

test('stdout 指向文件也要把八行都落进去（容器里留档用的就是这种形状）', () => {
    const out = path.join(stubDir(), 'out.txt')
    const handle = fs.openSync(out, 'w')
    const result = spawnSync(process.execPath, [probe, okStub(), '1730000000099'], { stdio: ['ignore', handle, 'ignore'] })
    fs.closeSync(handle)
    assert.equal(result.status, 0)
    assert.deepEqual(fs.readFileSync(out, 'utf8').trim().split(/\r?\n/), PROBE_STEPS)
})

test('导出不符合预期时停在 load，说清缺哪一个', () => {
    const out = run(probe, [stub('module.exports = { init() {} }'), '1730000000000'])
    assert.equal(out.code, 1)
    assert.deepEqual(out.lines.slice(-2), ['step=load', 'step=failed layer=load reason=exports hasInit=true hasSign=false'])
})

test('路径不存在时报的是类别，不是本机路径', () => {
    const missing = path.join(stubDir(), '没有这个文件.js')
    const out = run(probe, [missing, '1730000000000'])
    assert.equal(out.code, 1)
    assert.deepEqual(out.lines.slice(-1), ['step=failed layer=load reason=missing 这个路径上没有文件'])
    for (const text of [out.lines.join('\n'), out.stderr]) {
        assert.ok(!text.includes('libmssdk-layers'), `输出里不该带本机路径：${text}`)
        assert.ok(!text.includes('Program Files'), `输出里不该带本机路径：${text}`)
    }
})

test('一个路径都不给就说缺参数，不去猜默认值', () => {
    const out = run(probe, [])
    assert.equal(out.code, 1)
    assert.deepEqual(out.lines, ['step=begin', 'step=failed layer=args reason=missing 把 bdms.node 的路径作为第一个参数传进来'])
})

test('某一层抛了：报出「是抛的不是挂的」，卡在哪一层由上一条 step 说', () => {
    const out = run(probe, [stub('module.exports = { init() { throw new Error("boom") }, generateHttpSignatureHeaders() { return "" } }'), '1730000000000'])
    assert.equal(out.code, 1)
    assert.deepEqual(out.lines.slice(-2), ['step=init', 'step=failed reason=threw name=Error'])
    assert.ok(!out.stderr.includes('boom'), `抛出的原文不该复述：${out.stderr}`)
})

test('探针同时出现在 README 的坑条目与文件表里', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'verify/wine-multi/README.md'), 'utf8')
    assert.match(readme, /bdms-layers\.mjs/)
    assert.match(readme, /分层探针/)
})
