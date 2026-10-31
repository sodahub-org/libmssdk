// 命令行入口的黑盒用例：只跑不会出网的那几条路径。
//
// #9 把 /probe 收成命令行子命令，于是「子命令在不在、参数解析对不对、失败形态可不可读」
// 需要一份外部证据。真打上游那条路不在这里跑：npm test 不许出网，那是 tools/ 与手动自检的领域。
//
// 每条用例都自带一个临时 LIBMSSDK_STATE_DIR：入口在 import 阶段就会准备身份文件，
// 不能让它写进仓库的 data/。

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.join(here, '..', 'src', 'index.mjs')
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-cli-'))

after(() => fs.rmSync(stateDir, { recursive: true, force: true }))

async function run(...args) {
    const env = { ...process.env, LIBMSSDK_STATE_DIR: stateDir }
    // 设备号 / Cookie / 曲目 id 都可能从宿主环境漏进子进程：清掉，用例只认命令行参数
    for (const key of ['LIBMSSDK_DEVICE_ID', 'LIBMSSDK_COOKIE', 'LIBMSSDK_PROBE_TRACK_ID', 'LIBMSSDK_TOKEN']) {
        delete env[key]
    }
    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { env })
        return { code: 0, stdout, stderr }
    } catch (error) {
        return { code: error.code ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' }
    }
}

test('probe 子命令在，缺 track_id 时非零退出并说清缺什么', async () => {
    const { code, stdout, stderr } = await run('probe')
    assert.equal(code, 1, '缺参数要非零退出，脚本才判断得了')
    assert.match(stderr, /track_id 不能为空/, `失败形态要可读：${stderr}`)
    assert.equal(stdout, '', '出错的这条命令不该往 stdout 吐半截 JSON')
})

test('未知命令把可用的子命令列出来，probe 在其中', async () => {
    const { code, stdout } = await run('definitely-not-a-command')
    assert.equal(code, 2)
    assert.match(stdout, /serve \/ bridge \/ selftest \/ probe \/ config/)
})

test('config 命令的 stdout 是一个可解析的对象，设备号只出脱敏值', async () => {
    const { code, stdout } = await run('config')
    assert.equal(code, 0)
    const payload = JSON.parse(stdout)
    assert.match(payload.identity.deviceId, /^\d{3}\*\*\*\d{3}$/, '只出前 3 后 3')
    assert.equal(/\d{16}/.test(stdout), false, '完整设备号（16 位）不该出现在输出里')
    assert.equal(payload.identity.persisted, true, '临时 state 目录可写，身份应当落盘')
})
