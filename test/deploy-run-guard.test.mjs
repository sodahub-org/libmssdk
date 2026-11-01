// deploy/run.sh 的前置检查（#20）：声明了要挂反向代理，宿主的明文口就必须收进回环，否则拒启动。
//
// 这条收紧以前只在 README 与 compose 注释里，靠人读；跳过那一步的人照样在把 token 与 cookie
// 走明文发出去。所以用例跑的是真实的 run.sh，不在测试里重抄一遍判据 —— 「检查在不在、排在
// 构建之前还是之后、报错点不点名变量」只有整条脚本能给证据。
//
// compose 用一个桩顶掉：`docker compose version` 必须成功（run.sh 开头就探测它），其余调用一律回 42。
// 脚本是 set -e，构建那一步失败就整体退出，于是 42 读作「已通过全部前置检查、真的走到了 compose」，
// 而拒启动的那几条一次 `up` 都不许出现。整组用例不碰 docker，因此本机不需要装它。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { isLoopbackBind } from '../src/dispatch.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const RUN_SH = path.join(here, '..', 'deploy', 'run.sh')

// 桩对 compose 构建的固定返回值；见到它即表示前置检查都过了。
const REACHED_COMPOSE = 42

const COMPOSE_STUB = [
    '#!/usr/bin/env bash',
    'echo "docker $*" >>"$COMPOSE_STUB_LOG"',
    'case "$*" in',
    '    *version*) exit 0 ;;',
    '    *) exit 42 ;;',
    'esac',
    '',
].join('\n')

// 没有 bash 就跳过（Windows 上的 bash 来自 Git for Windows，CI 的 windows 作业里有）。
const haveBash = !spawnSync('bash', ['--version'], { encoding: 'utf8' }).error

/**
 * Git Bash 只认 /c/… 这种挂载写法，node 交回来的是 C:\… 反斜杠路径；直接当参数递给 bash 会被
 * 拆成转义串。Linux 上原样返回。
 */
function toShellPath(nativePath) {
    if (!/^[A-Za-z]:[\\/]/.test(nativePath)) return nativePath
    return nativePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_drive, letter) => `/${letter.toLowerCase()}`)
}

/** 宿主环境的 LIBMSSDK_* 与 SIGNER_HOSTNAME 会漏进子进程，把用例变成看人脸色的东西：清掉。 */
function childEnv() {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
        if (key.startsWith('LIBMSSDK_') || key === 'SIGNER_HOSTNAME') delete env[key]
    }
    return env
}

/**
 * 在临时目录里跑一遍真实的 deploy/run.sh。
 *
 * @param {string[]} [envLines] deploy/.env 的内容；不传就不建这个文件，让 run.sh 走首次生成的分支
 * @returns {{status: number, stdout: string, stderr: string, composeCalls: string[], envFile: string}}
 */
function runDeployScript(envLines) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'libmssdk-run-sh-'))
    try {
        const deployDir = path.join(work, 'deploy')
        fs.mkdirSync(deployDir)
        fs.copyFileSync(RUN_SH, path.join(deployDir, 'run.sh'))

        const stubPath = path.join(work, 'bin', 'docker')
        fs.mkdirSync(path.dirname(stubPath))
        fs.writeFileSync(stubPath, COMPOSE_STUB)
        // Linux 上没有执行位的脚本压根跑不起来；Windows 的 Git Bash 忽略这个位但也不报错。
        fs.chmodSync(stubPath, 0o755)

        const envFilePath = path.join(deployDir, '.env')
        if (envLines) fs.writeFileSync(envFilePath, `${envLines.join('\n')}\n`)

        // 桩的目录在 bash 内部拼进 PATH：env.PATH 里混一条 node 风格的 Windows 路径，
        // bash 会把它当成一个不存在的条目，桩就找不着了。
        const wrapper = 'export PATH="$1/bin:$PATH"; COMPOSE_STUB_LOG="$1/compose-calls.log" bash "$1/deploy/run.sh"'
        const result = spawnSync('bash', ['-c', wrapper, 'libmssdk-deploy', toShellPath(work)], {
            encoding: 'utf8',
            env: childEnv(),
        })
        if (result.error) throw result.error

        const logPath = path.join(work, 'compose-calls.log')
        const composeCalls = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []
        return {
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            composeCalls,
            // run.sh 开头就探测 `docker compose version`，所以「调过 docker」不等于「起过容器」；
            // 拒启动的用例要判的是有没有走到 up。
            started: composeCalls.some(call => /(?:^|\s)up(?:\s|$)/.test(call)),
            envFile: fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : '',
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true })
    }
}

/**
 * 拼一份 .env：只关心跟这条检查有关的变量，其余给足跑通前置检查的占位值。
 *
 * 带空白的值一律加双引号：`LIBMSSDK_TRUST_PROXY= on ` 这种写法在 `. ./.env` 里会被 bash 当成
 * 「赋值 + 命令」两段，变量根本没设上，用例号称测「值里有空白」其实测的是空值。加引号才把那个
 * 带空白的值真的送进 run.sh（compose 读 .env 也是这么处理引号的）。
 */
function envLine(key, value) {
    return `${key}=${/\s/.test(value) ? `"${value}"` : value}`
}

function deployEnv({ bind, hostname, trustProxy, allowPublicHttp } = {}) {
    const lines = [
        'LIBMSSDK_TOKEN=stub-token-not-a-secret',
        'LIBMSSDK_PORT=8899',
        // 非空才过得了 LIBMSSDK_CLIENT_DIR 那道检查；脚本只要求填了，不探测它存在
        'LIBMSSDK_CLIENT_DIR=/tmp/libmssdk-stub-client-dir',
    ]
    if (bind !== undefined) lines.push(envLine('LIBMSSDK_BIND', bind))
    if (hostname !== undefined) lines.push(envLine('SIGNER_HOSTNAME', hostname))
    if (trustProxy !== undefined) lines.push(envLine('LIBMSSDK_TRUST_PROXY', trustProxy))
    if (allowPublicHttp !== undefined) lines.push(envLine('LIBMSSDK_ALLOW_PUBLIC_HTTP', allowPublicHttp))
    return lines
}

test('设了 SIGNER_HOSTNAME 而宿主端口还发布到 0.0.0.0：拒启动，且压根不起容器', { skip: skipIfNoBash() }, () => {
    const { status, stderr, started } = runDeployScript(deployEnv({ bind: '0.0.0.0', hostname: 'signer.example.com' }))

    assert.equal(status, 1, '违规组合必须把启动拦住，而不是只留一句提示')
    assert.match(stderr, /SIGNER_HOSTNAME/, `错误信息要点名触发的变量：${stderr}`)
    assert.match(stderr, /LIBMSSDK_BIND/, `错误信息要点名要改的变量：${stderr}`)
    assert.match(stderr, /LIBMSSDK_BIND 就必须是 127\.0\.0\.1/, `要直接给出改法：${stderr}`)
    assert.match(stderr, /LIBMSSDK_ALLOW_PUBLIC_HTTP=1/, `要让人才知道有逃生舱：${stderr}`)
    assert.equal(started, false, '拒绝要发生在起容器之前')
})

test('只开 LIBMSSDK_TRUST_PROXY 也一并拦：宿主端口对外时 XFF 能伪造，限流等于没开', { skip: skipIfNoBash() }, () => {
    const { status, stderr, started } = runDeployScript(deployEnv({ bind: '0.0.0.0', trustProxy: '1' }))

    assert.equal(status, 1, 'README 第 3 步那条前提要落到脚本里，不能只是说法')
    assert.match(stderr, /LIBMSSDK_TRUST_PROXY/, `要说清是哪一个变量触发的：${stderr}`)
    assert.match(stderr, /X-Forwarded-For/, `要说清为什么这算违规：${stderr}`)
    assert.equal(started, false, '同样要拦在起容器之前')
})

test('LIBMSSDK_BIND=127.0.0.1 时放行：收紧的只是宿主那一侧，代理经服务名照常访问', { skip: skipIfNoBash() }, () => {
    const { status, composeCalls, started } = runDeployScript(deployEnv({ bind: '127.0.0.1', hostname: 'signer.example.com' }))

    assert.equal(status, REACHED_COMPOSE, '合规配置要走到 compose 那一步')
    assert.equal(started, true, `要真的走到起容器那一步：${composeCalls.join(' | ')}`)
})

test('逃生舱：LIBMSSDK_ALLOW_PUBLIC_HTTP=1 放行，但要说破明文这件事', { skip: skipIfNoBash() }, () => {
    const { status, stderr, started } = runDeployScript(
        deployEnv({ bind: '0.0.0.0', hostname: 'signer.example.com', allowPublicHttp: '1' }),
    )

    assert.equal(status, REACHED_COMPOSE, '设了逃生舱就不该再拦，否则内网部署没法用')
    assert.doesNotMatch(stderr, /错误/, `放行时不该同时报错误：${stderr}`)
    assert.match(stderr, /LIBMSSDK_ALLOW_PUBLIC_HTTP/, `提醒要点名是逃生舱放行的：${stderr}`)
    assert.match(stderr, /明文/, `提醒要说清风险还在：${stderr}`)
    assert.equal(started, true, '放行就要继续往下走')

    // 值里带空白（或 .env 是 CRLF）不该让人被拦下后去做他已经在做的事：这里照样放行
    for (const value of [' 1 ', '1\r']) {
        const spaced = runDeployScript(deployEnv({ bind: '0.0.0.0', hostname: 'signer.example.com', allowPublicHttp: value }))

        assert.equal(spaced.status, REACHED_COMPOSE, `LIBMSSDK_ALLOW_PUBLIC_HTTP=${JSON.stringify(value)} 也该放行`)
        assert.equal(spaced.started, true)
    }
    // 但它只认 "1"，别的写法一律当作没开（放开风险的开关，保守方向要落在拦这边）
    for (const value of ['true', '0', '']) {
        const { status } = runDeployScript(deployEnv({ bind: '0.0.0.0', hostname: 'signer.example.com', allowPublicHttp: value }))

        assert.equal(status, 1, `LIBMSSDK_ALLOW_PUBLIC_HTTP=${JSON.stringify(value)} 不该当成放行`)
    }
})

test('没声明反向代理时不拦：0.0.0.0 归部署者自己管，脚本不替内网部署做主', { skip: skipIfNoBash() }, () => {
    const { status, started } = runDeployScript(deployEnv({ bind: '0.0.0.0' }))

    assert.equal(status, REACHED_COMPOSE, '这条检查只管「挂了反代却留着明文口」')
    assert.equal(started, true)
})

test('回环判据与 src/dispatch.mjs 的 isLoopbackBind 逐条一致', { skip: skipIfNoBash() }, () => {
    // 两处判据分别写在 bash 与服务里（部署脚本不能 import 服务的模块），会漂移的正是这一份表。
    // 同一批地址，两边说「是回环」的必须是同一批 —— 谁先改了口径，这条用例就红。
    // 空值不在表里：.env 没写 LIBMSSDK_BIND 时 compose 缺省只绑回环，那是下面单独一条用例。
    const addresses = [
        '127.0.0.1', '127.5.5.5', '127.999.1.1', '127.0.0.01', '127.0.0',
        '127.evil.com', 'localhost', 'Localhost', ' ::1 ', '::1',
        '[::1]', '0:0:0:0:0:0:0:1', '0.0.0.0', '::', '10.0.0.8', 'evil.example.com',
    ]
    for (const bind of addresses) {
        const loopback = isLoopbackBind(bind)
        const { status, started } = runDeployScript(deployEnv({ bind, hostname: 'signer.example.com' }))

        // 挂了反代（这里用 SIGNER_HOSTNAME 声明）时，脚本的放行与拦下必须跟着 isLoopbackBind 的答案走：
        // 回环 → 放行到 compose，非回环 → 拦在 compose 之前。
        assert.equal(started, loopback, `${bind}：isLoopbackBind 说 ${loopback}，脚本必须给同一个答案`)
        assert.equal(status, loopback ? REACHED_COMPOSE : 1, `${bind}：退出码要和上面那句对得上`)
    }
})

test('LIBMSSDK_TRUST_PROXY 的「打开」跟服务里 envFlag 同口径：true/yes/on 都算', { skip: skipIfNoBash() }, () => {
    // compose 把这个变量原样透传进容器，而 src/config.mjs 认 ['1','true','yes','on']（先去空白、不分大小写）。
    // 脚本只认 "1" 的话，LIBMSSDK_TRUST_PROXY=true 就变成「服务在公网口上认 XFF，脚本一声不吭」；
    // 少了 trim 的话 `" on "` 又会溜过去 —— .env 里带空格是常事，两种都得拦住。
    for (const value of ['true', 'TRUE', 'yes', 'on', ' on ', '  Yes  ', '\tON\t', '1 ']) {
        const { status, started } = runDeployScript(deployEnv({ bind: '0.0.0.0', trustProxy: value }))

        assert.equal(status, 1, `TRUST_PROXY=${JSON.stringify(value)} 也是打开了，要拦住`)
        assert.equal(started, false, `TRUST_PROXY=${JSON.stringify(value)} 要拦在起容器之前`)
    }
    for (const value of ['0', 'false', 'off', '', ' ', 'false ', 'no']) {
        const { status, started } = runDeployScript(deployEnv({ bind: '0.0.0.0', trustProxy: value }))

        assert.equal(status, REACHED_COMPOSE, `TRUST_PROXY=${JSON.stringify(value)} 是没打开，不该误拦`)
        assert.equal(started, true, `TRUST_PROXY=${JSON.stringify(value)} 要继续往下走`)
    }
})

test('.env 没写 LIBMSSDK_BIND 时不误拦：compose 的缺省本来就只绑回环', { skip: skipIfNoBash() }, () => {
    // 判据问的是「宿主端口是否对外」，所以缺省值必须跟 docker-compose.yml 的
    // ${LIBMSSDK_BIND:-127.0.0.1} 同口径；照 0.0.0.0 兜底会把一份本就安全的配置报成违规。
    const { status, stderr, started } = runDeployScript(deployEnv({ hostname: 'signer.example.com' }))

    assert.equal(status, REACHED_COMPOSE, `没写这一行时 compose 只绑 127.0.0.1，不是违规：${stderr}`)
    assert.equal(started, true)
})

test('run.sh 首次生成的 .env 写清了这条检查与逃生舱', { skip: skipIfNoBash() }, () => {
    // 不传 envLines：走「首次生成 .env」那一支。生成的模板是唯一会给新用户看的东西，
    // 收紧这件事要么写在模板里，要么就别指望人读 README。
    const { status, stderr, envFile } = runDeployScript()

    assert.equal(status, 1, 'LIBMSSDK_CLIENT_DIR 还没填，本该停在那一步')
    assert.match(stderr, /LIBMSSDK_CLIENT_DIR/)
    assert.match(envFile, /run\.sh.*拒绝启动/, `模板要说清不收紧的后果：${envFile}`)
    assert.match(envFile, /# LIBMSSDK_ALLOW_PUBLIC_HTTP=0/, `逃生舱要在模板里看得见：${envFile}`)
    assert.match(envFile, /# SIGNER_HOSTNAME=signer\.example\.com/, '反代那一层的变量仍按原样注释着')
})

function skipIfNoBash() {
    return haveBash ? false : '本机找不到 bash，deploy/run.sh 这组用例跑不了'
}
