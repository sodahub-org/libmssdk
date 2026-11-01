// 排空窗口的几个硬关系，写在 Dockerfile、compose 与 verify 入口里，各自漂移时用例先红：
//   1. compose 的窗口必须大于 HEALTHCHECK 的「间隔 + 超时」，否则停止期间一次都采不到
//      /readyz 的 503（Docker 从上次检查结束起算下一次）；
//   2. 窗口 + 在飞请求的等待预算（LIBMSSDK_WAIT_BUDGET_MS 默认 5000）必须小于
//      stop_grace_period，否则进程会在收尾途中被硬杀；
//   3. verify 入口用的窗口与 compose 保持一致（它自己用 250ms 轮询采样，不套用镜像节奏）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')

/** 等待预算从源码读，别在测试里抄一份会漂移的数字。 */
function waitBudgetMs() {
    const match = /^const DEFAULT_WAIT_BUDGET_MS = (\d+)/m.exec(read('src/dispatcher.mjs'))
    assert.ok(match, 'src/dispatcher.mjs 里读不到 DEFAULT_WAIT_BUDGET_MS')
    return Number(match[1])
}

/** 只认 HEALTHCHECK 那一行：注释里出现的 --interval= 不算配置。 */
function healthcheckBudgetMs() {
    const line = read('deploy/Dockerfile')
        .split('\n')
        .find(text => text.trimStart().startsWith('HEALTHCHECK'))
    assert.ok(line, 'deploy/Dockerfile 里找不到以 HEALTHCHECK 开头的行')
    const interval = /--interval=(\d+)s/.exec(line)
    const timeout = /--timeout=(\d+)s/.exec(line)
    assert.ok(interval && timeout, `HEALTHCHECK 行里读不到 interval / timeout：${line}`)
    return { interval: Number(interval[1]) * 1000, timeout: Number(timeout[1]) * 1000 }
}

const composeDrainMs = () => {
    const match = /^\s*LIBMSSDK_DRAIN_DELAY_MS:\s*"\$\{LIBMSSDK_DRAIN_DELAY_MS:-(\d+)\}"/m.exec(
        read('deploy/docker-compose.yml'),
    )
    assert.ok(match, 'deploy/docker-compose.yml 里读不到排空窗口的默认值')
    return Number(match[1])
}

const stopGraceMs = () => {
    const match = /^\s*stop_grace_period:\s*(\d+)s\s*$/m.exec(read('deploy/docker-compose.yml'))
    assert.ok(match, 'deploy/docker-compose.yml 里读不到 stop_grace_period')
    return Number(match[1]) * 1000
}

const verifyDrainMs = () => {
    const match = /^\s*export LIBMSSDK_DRAIN_DELAY_MS="\$\{LIBMSSDK_DRAIN_DELAY_MS:-(\d+)\}"/m.exec(
        read('verify/wine-multi/container-entry.sh'),
    )
    assert.ok(match, 'verify/wine-multi/container-entry.sh 里读不到排空窗口的默认值')
    return Number(match[1])
}

test('compose 的排空窗口大于健康检查的「间隔 + 超时」', () => {
    const { interval, timeout } = healthcheckBudgetMs()
    assert.ok(interval > 0 && timeout > 0, `HEALTHCHECK 的间隔/超时必须是正数：${interval}/${timeout}`)
    assert.ok(
        composeDrainMs() > interval + timeout,
        `compose 排空窗口 ${composeDrainMs()}ms 必须大于 ${interval}ms + ${timeout}ms`,
    )
})

test('排空窗口 + 等待预算小于 stop_grace_period', () => {
    assert.ok(
        composeDrainMs() + waitBudgetMs() < stopGraceMs(),
        `排空 ${composeDrainMs()}ms + 等待预算 ${waitBudgetMs()}ms 必须小于停止宽限 ${stopGraceMs()}ms`,
    )
})

test('verify 入口的排空窗口与 compose 保持一致', () => {
    assert.equal(
        verifyDrainMs(),
        composeDrainMs(),
        'verify 入口与 compose 用不同的窗口，观察到的形态会和真实部署对不上',
    )
})
