// 日志红线：约定只允许「请求形状 + 签名长度 + 脱敏设备号」，Cookie / X-Helios / X-Medusa
// 与本机路径一律不落盘。这里钉的是最容易走漏的那条路 —— 报错原文。

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const { redactHeaders, redactMachinePaths, redactMachinePathsDeep } = await import('../src/log.mjs')

test('脱敏的是凭据本身，长度留着（排查要靠它）', () => {
    const redacted = redactHeaders({
        'user-agent': 'LunaPC/3.8.0',
        cookie: 'sessionid_ss=abcdefghij',
        'X-Medusa': 'WQIDBAZg',
        'x-helios': 'AAAA',
    })
    assert.equal(redacted['user-agent'], 'LunaPC/3.8.0', '非凭据的头照原样留着')
    assert.equal(redacted.cookie, '<redacted 23 chars>')
    assert.equal(redacted['X-Medusa'], '<redacted 8 chars>')
    assert.equal(redacted['x-helios'], '<redacted 4 chars>')
    assert.equal(JSON.stringify(redacted).includes('abcdefghij'), false)
    assert.equal(JSON.stringify(redacted).includes('WQIDBAZg'), false)
})

test('报错原文里的本机路径一律换掉，包括依赖目录与 home', () => {
    const modulePath = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Soda Music\\3.7.0\\bdms.node'
    const locations = [modulePath, 'C:\\Users\\dev\\AppData\\Local\\Programs\\Soda Music\\3.7.0', 'C:\\Users\\dev']
    const raw = `bdms.node 不存在：${modulePath}；请在 C:\\Users\\dev\\libmssdk 里配置`
    const redacted = redactMachinePaths(raw, locations)
    assert.equal(redacted.includes('C:\\'), false, `还是漏了：${redacted}`)
    assert.equal(redacted.includes('dev'), false, 'home 目录被换掉之后不该剩片段用户名')
    assert.match(redacted, /bdms\.node 不存在：\(本机路径\)/, '话要说全，只留「不存在」就够了')
})

test('父目录不能先命中：home 下的项目根要整条换掉，不留半截', () => {
    // test/ 就在仓库根下，这一条用的正是「home 是项目根父目录」那种真实布局。
    const text = path.resolve(here, '..', 'src', 'bdms.mjs')
    assert.equal(redactMachinePaths(text), path.join('(本机路径)', 'src', 'bdms.mjs'))
})

test('父目录不能先命中：候选顺序反着传也整条换掉', () => {
    // 与真实布局同形：项目根嵌在 home 下面。传候选时故意把父目录排前面，
    // 排序一旦丢了，home 会先把项目根切成半截，留下 orca/workspaces/… 这种残段。
    const home = path.join(os.tmpdir(), 'libmssdk-home')
    const projectRoot = path.join(home, 'orca', 'workspaces', 'libmssdk', 'worktree')
    const text = path.join(projectRoot, 'src', 'bdms.mjs')
    assert.equal(
        redactMachinePaths(text, [home, projectRoot]),
        `${'(本机路径)'}${path.sep}src${path.sep}bdms.mjs`,
    )
})

test('没给路径候选时原样返回，不吞掉信息', () => {
    assert.equal(redactMachinePaths('签名不完整：只拿到 0 个头（）', []), '签名不完整：只拿到 0 个头（）')
    assert.equal(redactMachinePaths(undefined, ['/nope']), '')
})

test('对象里的字符串逐个脱敏，嵌套字段也不漏', () => {
    const dir = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Soda Music\\3.7.0'
    const value = {
        bdmsModule: `${dir}\\bdms.node`,
        nested: { identity: `state (${dir}\\data\\identity.json)` },
        count: 3,
        ok: true,
        list: [`${dir}\\metasecml.dll`],
    }
    const redacted = redactMachinePathsDeep(value, [dir])
    assert.equal(JSON.stringify(redacted).includes('C:\\\\'), false, `还是漏了：${JSON.stringify(redacted)}`)
    assert.equal(redacted.count, 3, '非字符串原样保留')
    assert.equal(redacted.ok, true)
    assert.deepEqual(redacted.list, ['(本机路径)\\metasecml.dll'])
})
