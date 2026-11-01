// 排空窗口与探针节奏的不变量：窗口必须大于「间隔 + 超时」，否则停止期间一次都采不到
// /readyz 的 503（#23 评论返修）。这个数字写在 Dockerfile、compose 与 verify 入口三处，
// 各自漂移时用例先红，而不是等真机验证才发现观察项永远读不到 503。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')

/** Docker 是从上一次检查结束起算下一次的，所以最坏间隔是 interval + timeout。 */
function healthcheckBudgetMs() {
    const dockerfile = read('deploy/Dockerfile')
    const interval = /--interval=(\d+)s/.exec(dockerfile)
    const timeout = /--timeout=(\d+)s/.exec(dockerfile)
    assert.ok(interval && timeout, 'deploy/Dockerfile 里读不到 HEALTHCHECK 的 interval / timeout')
    return { interval: Number(interval[1]) * 1000, timeout: Number(timeout[1]) * 1000 }
}

const composeDrainMs = () => {
    const compose = read('deploy/docker-compose.yml')
    const match = /LIBMSSDK_DRAIN_DELAY_MS:\s*"\$\{LIBMSSDK_DRAIN_DELAY_MS:-(\d+)\}"/.exec(compose)
    assert.ok(match, 'deploy/docker-compose.yml 里读不到排空窗口的默认值')
    return Number(match[1])
}

const verifyDrainMs = () => {
    const entry = read('verify/wine-multi/container-entry.sh')
    const match = /LIBMSSDK_DRAIN_DELAY_MS="\$\{LIBMSSDK_DRAIN_DELAY_MS:-(\d+)\}"/.exec(entry)
    assert.ok(match, 'verify/wine-multi/container-entry.sh 里读不到排空窗口的默认值')
    return Number(match[1])
}

test('compose 的排空窗口大于健康检查的「间隔 + 超时」', () => {
    const { interval, timeout } = healthcheckBudgetMs()
    assert.ok(interval > 0 && timeout > 0, `HEALTHCHECK 的间隔/超时必须是正数：${interval}/${timeout}`)
    assert.ok(
        composeDrainMs() > interval + timeout,
        `compose 的排空窗口 ${composeDrainMs()}ms 必须大于 ${interval}ms + ${timeout}ms`,
    )
})

test('verify 入口的排空窗口满足同一个不变量', () => {
    const { interval, timeout } = healthcheckBudgetMs()
    assert.ok(
        verifyDrainMs() > interval + timeout,
        `verify 的排空窗口 ${verifyDrainMs()}ms 必须大于 ${interval}ms + ${timeout}ms`,
    )
})
