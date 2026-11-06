// 配置层的两个显式路径判据：路径从环境变量进来，判据本身不碰文件内容（只查存在性）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const { missingExplicitBdmsModule } = await import('../src/config.mjs')

const here = path.dirname(fileURLToPath(import.meta.url))
const mockBdms = path.join(here, 'fixtures', 'mock-bdms.mjs')
const KEYS = ['LIBMSSDK_BDMS_MODULE', 'QISHUI_BDMS_PATH']

/** 只在回调期间改这两个环境变量；结束时连「原本没设」也恢复成没设。 */
function withEnv(values, fn) {
    const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]))
    for (const key of KEYS) delete process.env[key]
    Object.assign(process.env, values)
    try {
        return fn()
    } finally {
        for (const key of KEYS) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
    }
}

test('没有显式模块路径时不算配置错误：默认探测找不到模块仍按原行为启动', () => {
    assert.equal(withEnv({}, () => missingExplicitBdmsModule()), false)
})

test('显式路径存在时不拒启；不存在时拒启，两个变量名都认', () => {
    assert.equal(withEnv({ LIBMSSDK_BDMS_MODULE: mockBdms }, () => missingExplicitBdmsModule()), false)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-config-missing-'))
    const missing = path.join(dir, 'bdms.node')
    try {
        assert.equal(withEnv({ LIBMSSDK_BDMS_MODULE: missing }, () => missingExplicitBdmsModule()), true)
        assert.equal(withEnv({ QISHUI_BDMS_PATH: missing }, () => missingExplicitBdmsModule()), true)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
