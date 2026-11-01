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

import { envFlag } from '../src/config.mjs'
import { isLoopbackBind } from '../src/dispatch.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const RUN_SH = path.join(here, '..', 'deploy', 'run.sh')

// 桩对 compose 构建的固定返回值；见到它即表示前置检查都过了。
const REACHED_COMPOSE = 42

// 桩：`docker compose version` 必须成功（run.sh 开头就探测它）；起容器那一步固定回 42，并顺手记下
// 自己环境里有哪些 run.sh 的局部变量被导出来了 —— allexport 没关掉时 bind_value、is_loopback 这些
// 会一路带进子进程环境，那是外部可见的事实，值得钉一条。
const COMPOSE_STUB = [
    '#!/usr/bin/env bash',
    'echo "docker $*" >>"$COMPOSE_STUB_LOG"',
    'case "$*" in',
    '    *version*) exit 0 ;;',
    '    *)',
    '        echo "leaked:$(compgen -e | grep -E \'^(bind_value|octet|is_loopback|trust_proxy)$\' | tr \'\\n\' \',\')" >>"$COMPOSE_STUB_LOG"',
    '        exit 42 ;;',
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
 * @returns {{status: number, stderr: string, composeCalls: string[], leakedVars: string, envFile: string}}
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
        const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []
        const composeCalls = log.filter(line => line.startsWith('docker '))
        const leaked = log.find(line => line.startsWith('leaked:')) || ''
        return {
            status: result.status,
            stderr: result.stderr,
            composeCalls,
            // run.sh 的局部变量出现在 compose 子进程的环境里 = allexport 没关掉（见 run.sh 的 set -a）
            leakedVars: leaked.slice('leaked:'.length),
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

function deployEnv({ bind, hostname, trustProxy, allowPublicHttp, extra = [] } = {}) {
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
    // 要复现「这一行本身就写坏了」的用例走这里：不经 envLine，原样落进 .env
    return [...lines, ...extra]
}

/** 问服务自己：这个 LIBMSSDK_TRUST_PROXY 的写法算不算「打开了」。 */
function serviceTrustsProxy(value) {
    const previous = process.env.LIBMSSDK_TRUST_PROXY
    process.env.LIBMSSDK_TRUST_PROXY = value
    try {
        return envFlag('LIBMSSDK_TRUST_PROXY')
    } finally {
        if (previous === undefined) delete process.env.LIBMSSDK_TRUST_PROXY
        else process.env.LIBMSSDK_TRUST_PROXY = previous
    }
}

test('设了 SIGNER_HOSTNAME 而宿主端口还发布到 0.0.0.0：拒启动，且压根不起容器', { skip: skipIfNoBash() }, () => {
    const { status, stderr, started } = runDeployScript(deployEnv({ bind: '0.0.0.0', hostname: 'signer.example.com' }))

    assert.equal(status, 1, '违规组合必须把启动拦住，而不是只留一句提示')
    assert.match(stderr, /SIGNER_HOSTNAME/, `错误信息要点名触发的变量：${stderr}`)
    assert.match(stderr, /LIBMSSDK_BIND/, `错误信息要点名要改的变量：${stderr}`)
    assert.match(stderr, /LIBMSSDK_BIND 就必须收进回环/, `要直接给出改法：${stderr}`)
    assert.match(stderr, /127\.0\.0\.1/, `改法要写到具体值：${stderr}`)
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

test('LIBMSSDK_TRUST_PROXY 的「打开」与服务里 envFlag 逐条一致', { skip: skipIfNoBash() }, () => {
    // compose 把这个变量原样透传进容器：脚本认得比服务窄（只认 "1"）时，LIBMSSDK_TRUST_PROXY=true
    // 就变成「服务在对外口上认 XFF，脚本一声不吭」—— 那是要命的方向，必须逐条对上。
    // 答案不在这张表里手写，而是现取 src/config.mjs 的 envFlag：那边加了新写法，这条用例要红。
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' on ', '\tON\t', '0', '', ' ', 'no', '2']) {
        const trusts = serviceTrustsProxy(value)
        const { status, started } = runDeployScript(deployEnv({ bind: '0.0.0.0', trustProxy: value }))

        assert.equal(started, !trusts, `TRUST_PROXY=${JSON.stringify(value)}：envFlag 说 ${trusts}，脚本必须给同一个答案`)
        assert.equal(status, trusts ? 1 : REACHED_COMPOSE, `TRUST_PROXY=${JSON.stringify(value)}：退出码要和上面那句对得上`)
    }

    // 反方向允许不一致：脚本去的是所有空白，envFlag 只 trim 两端。`t rue` 这种写法服务当没打开、
    // 脚本当打开了 —— 多拦一道不会放出风险，误拦的代价是一句报错。这里把它钉成「已知更严」，
    // 免得以后有人照着上面那句「逐条一致」去把脚本改宽。
    const wider = runDeployScript(deployEnv({ bind: '0.0.0.0', trustProxy: 't rue' }))
    assert.equal(serviceTrustsProxy('t rue'), false, 'envFlag 认不出 t rue')
    assert.equal(wider.status, 1, '脚本按打开处理，多拦一道')
})

test('.env 没写 LIBMSSDK_BIND 时不误拦：compose 的缺省本来就只绑回环', { skip: skipIfNoBash() }, () => {
    // 判据问的是「宿主端口是否对外」，所以缺省值必须跟 docker-compose.yml 的
    // ${LIBMSSDK_BIND:-127.0.0.1} 同口径；照 0.0.0.0 兜底会把一份本就安全的配置报成违规。
    const { status, stderr, started } = runDeployScript(deployEnv({ hostname: 'signer.example.com' }))

    assert.equal(status, REACHED_COMPOSE, `没写这一行时 compose 只绑 127.0.0.1，不是违规：${stderr}`)
    assert.equal(started, true)
})

test('.env 里 bash 读不进去的那一行：宁可停，也不按缺省放行', { skip: skipIfNoBash() }, () => {
    // `LIBMSSDK_BIND = 0.0.0.0` 在 bash 里是「跑一个叫 LIBMSSDK_BIND 的命令」，变量根本没设上；
    // 这时按缺省值判，等于对着一份 compose 照旧会用的 0.0.0.0 说「没问题」。走 extra 写裸行，
    // 要复现的正是人手写 .env 时最容易敲出来的那一型（等号两侧空格、export 前缀）。
    const malformed = [
        // 坏分隔符形状：等号前有空白、等号后有空白、YAML 式冒号（compose-go 的 dotenv 把 '=' 与 ':'
        // 都当分隔符，bash 只会把 `LIBMSSDK_BIND:` 当一个命令名），以及它们与引号／export 的组合
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND = 0.0.0.0'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND= 0.0.0.0'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND = "0.0.0.0"'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ["LIBMSSDK_BIND = '0.0.0.0'"] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND: 0.0.0.0'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND:0.0.0.0'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND: "#0.0.0.0"'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['export LIBMSSDK_BIND = 0.0.0.0'] }),
        deployEnv({ bind: '0.0.0.0', extra: ['SIGNER_HOSTNAME = signer.example.com'] }),
        deployEnv({ bind: '0.0.0.0', extra: ['LIBMSSDK_TRUST_PROXY = 1'] }),
        deployEnv({ bind: '0.0.0.0', extra: ['LIBMSSDK_TRUST_PROXY: yes'] }),
        // 同一个键写两行、后一行是坏形状：bash 留着前一行的好值继续跑，脚本只看「变量非空」就会放过去
        deployEnv({ hostname: 'signer.example.com', bind: '127.0.0.1', extra: ['LIBMSSDK_BIND: 0.0.0.0'] }),
        deployEnv({ hostname: 'signer.example.com', bind: '127.0.0.1', extra: ['LIBMSSDK_BIND = 0.0.0.0'] }),
        // 形状没问题、值里有空格又没加引号：bash 把整行丢掉（那个赋值只在紧随其后的命令的有效范围内
        // 存在），变量为空 —— 只看形状会漏这一型，所以还配了「变量为空 + 文件确实声明了值」那条判据
        deployEnv({ extra: ['SIGNER_HOSTNAME=signer example.com', 'LIBMSSDK_BIND=0.0.0.0'] }),
        deployEnv({ extra: ['LIBMSSDK_BIND=0.0.0.0', 'LIBMSSDK_TRUST_PROXY=1 x'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND=0.0.0.0 127.0.0.1'] }),
    ]
    for (const lines of malformed) {
        const { status, stderr, started } = runDeployScript(lines)

        assert.equal(status, 1, `读不动的 .env 要停下，不能靠缺省放行：${stderr}`)
        assert.equal(started, false, '不能带着「脚本看不见这个值」继续起容器')
        assert.match(stderr, /bash 读不进去/, `要说清是这一行读不进去：${stderr}`)
    }

    // 逃生舱同判据里的一条：它写坏了却不去认，报错就会叫用户去做他已经做过的事
    const hatch = runDeployScript(
        deployEnv({ bind: '0.0.0.0', trustProxy: '1', extra: ['LIBMSSDK_ALLOW_PUBLIC_HTTP = 1'] }),
    )
    assert.equal(hatch.status, 1, '逃生舱写坏时也是拒启动')
    assert.match(hatch.stderr, /bash 读不进去/, `要说的是这一行读不进去：${hatch.stderr}`)
    assert.doesNotMatch(hatch.stderr, /设 LIBMSSDK_ALLOW_PUBLIC_HTTP=1/, `不该反过来教用户设他正设着的东西：${hatch.stderr}`)
})

test('客户端目录里有空格又没加引号：报「这一行读不进去」，不是「你还没填」', { skip: skipIfNoBash() }, () => {
    // `.env.example` 之前就是这一型（LIBMSSDK_CLIENT_DIR=C:\Users\<you>\...\Soda Music\3.7.0）。
    // bash 把整行丢掉，变量为空，于是 1.2 会报「请先设置 LIBMSSDK_CLIENT_DIR」—— 叫用户去做他刚做过的事。
    // 这条用例盯的就是那个误导：诊断必须是「这一行读不进去」，并且改法是加引号。
    const { status, stderr } = runDeployScript([
        'LIBMSSDK_TOKEN=stub-token-not-a-secret',
        'LIBMSSDK_CLIENT_DIR=C:\\Program Files\\Soda Music\\3.7.0',
    ])

    assert.equal(status, 1, `读不进去的行要停下：${stderr}`)
    assert.match(stderr, /bash 读不进去/, `要说清是这一行读不进去：${stderr}`)
    assert.doesNotMatch(stderr, /请先在 deploy\/\.env 设置 LIBMSSDK_CLIENT_DIR/, `不该说「你还没填」：${stderr}`)

    // 同一个值加上双引号就是合法配置，必须一路走到 compose
    const quoted = runDeployScript([
        'LIBMSSDK_TOKEN=stub-token-not-a-secret',
        'LIBMSSDK_CLIENT_DIR="C:\\Program Files\\Soda Music\\3.7.0"',
        'LIBMSSDK_BIND=127.0.0.1',
    ])
    assert.equal(quoted.status, REACHED_COMPOSE, `带引号的同一路径不该被拦：${quoted.stderr}`)
})

test('.env 把 LIBMSSDK_BIND 写成空值：与 compose 的 ${LIBMSSDK_BIND:-127.0.0.1} 一样按回环算', { skip: skipIfNoBash() }, () => {
    // 空值与「这一行压根没写」是同一件事（compose 的 :- 对两者都取缺省），既不该被读不进去那条拦下，
    // 也不该被回环检查误拦。引号包住的空值（KEY="" / KEY=''）同属「设了但为空」，bash 读得进去。
    const empties = [
        deployEnv({ bind: '', hostname: 'signer.example.com' }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND=""'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ["LIBMSSDK_BIND=''"] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND= # 留空按缺省走回环'] }),
        // 冒号那一种也一样：没有真实值的行不算「读不进去」（compose 读成空 = 没写 = 缺省回环）
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND:'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND: ""'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ["LIBMSSDK_BIND: ''"] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND: # 留着当备忘'] }),
        // 「没填」的写法还要多认几种：空引号后面跟注释、后面拖空白，以及 CRLF 文件里那个 \r。
        // 少认一种，就会把一份本就安全的配置报成「读不进去」，或者回一句「现在是 」。
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND="" # 备忘'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND=""  '] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND=\r'] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND: ""\r'] }),
        // 判据只看「最后一次声明」，这两种都必须放行：先一行有值、后一行清空（两边都按没填走缺省），
        // 以及先一行是坏形状、后一行改对了（后写的盖掉先写的，脚本没有理由再拦前一行的旧写法）。
        deployEnv({ hostname: 'signer.example.com', bind: '127.0.0.1', extra: ['LIBMSSDK_BIND='] }),
        deployEnv({ hostname: 'signer.example.com', extra: ['LIBMSSDK_BIND = 0.0.0.0', 'LIBMSSDK_BIND=127.0.0.1'] }),
    ]
    for (const lines of empties) {
        const { status, stderr, started } = runDeployScript(lines)

        assert.equal(status, REACHED_COMPOSE, `空值不是「读不进去」，也不该误拦：${stderr}`)
        assert.equal(started, true)
    }
})

test('.env 里跑失败的一行不会把 allexport 留在开着：脚本的局部变量不进 compose 子进程', { skip: skipIfNoBash() }, () => {
    // 1.1 只盯 run.sh 自己要用的那几个键；这份 .env 里坏掉的是别的键（NOTE），脚本必须照常走完，
    // 但 `set -a && . ./.env && set +a` 这种串法会在这一行失败时跳过 set +a —— 之后 bind_value、
    // is_loopback，连签名自检拿到的响应都会被导进容器环境。这里看的是起容器那一步的真实环境。
    const { status, leakedVars } = runDeployScript(deployEnv({ bind: '127.0.0.1', hostname: 'signer.example.com', extra: ['NOTE = keep-plaintext'] }))

    assert.equal(status, REACHED_COMPOSE, '与检查无关的坏行不该把部署拦下')
    assert.equal(leakedVars, '', `run.sh 的局部变量不该出现在 compose 子进程的环境里：${leakedVars}`)
})

test('run.sh 首次生成的 .env 写清了这条检查与逃生舱', { skip: skipIfNoBash() }, () => {
    // 不传 envLines：走「首次生成 .env」那一支。生成的模板是唯一会给新用户看的东西，
    // 收紧这件事要么写在模板里，要么就别指望人读 README。
    const { status, stderr, envFile } = runDeployScript()

    assert.equal(status, 1, 'LIBMSSDK_CLIENT_DIR 还没填，本该停在那一步')
    assert.match(stderr, /LIBMSSDK_CLIENT_DIR/)
    // 1.1 现在排在 CLIENT_DIR 之前，模板本身一旦被判成「读不进去」就会顶掉这条更早的报错 —— 两种停下要分得开
    assert.doesNotMatch(stderr, /bash 读不进去/, `生成的模板不该被 1.1 误判：${stderr}`)
    assert.match(envFile, /run\.sh.*拒绝启动/, `模板要说清不收紧的后果：${envFile}`)
    assert.match(envFile, /# LIBMSSDK_ALLOW_PUBLIC_HTTP=0/, `逃生舱要在模板里看得见：${envFile}`)
    assert.match(envFile, /# SIGNER_HOSTNAME=signer\.example\.com/, '反代那一层的变量仍按原样注释着')
})

function skipIfNoBash() {
    return haveBash ? false : '本机找不到 bash，deploy/run.sh 这组用例跑不了'
}
