#!/usr/bin/env node
// 反向代理示例配置的离线校验：仓库交付的两份配置在合入前就被验一遍语法。
//
// - Caddyfile：官方镜像里跑 `caddy validate`，变量齐全时须通过，缺任意一个变量时须失败，
//   且报错要指到具体行（不是一句 exit code）。
// - deploy/README.md 里标记为 caddyfile 的代码块（那段路径白名单示例）一起验。
// - 结构对照：nginx 的免日志 location 必须覆盖 src/endpoints.mjs 的 PROBE_PATHS
//   （/healthz 是 /readyz 的别名），README 白名单必须放行 /sign 与全部探针、挡住 /stat。
//   漏一项 nginx -t 不会报（语法是对的），所以单列这道检查。只查「覆盖」、不禁止多关一条日志：
//   额外收紧（比如 /stat）不该让 CI 红。
// - Caddy 路径写法只在可核对范围内判：字面量与收尾 `*` 前缀匹配。`?`、字符类、占位符、
//   `%` 转义、`//` 与非收尾 `*` 一律报「超出可核对范围」，绝不按字面量静默放过。
// - nginx.conf：临时造一份自签证书，按官方镜像的 conf.d 用法跑 `nginx -t`（镜像自带的 nginx.conf
//   就是那个最小 `http {}` 外壳）；再注入一条非法指令，确认失败信息能指到行号（证明验的确实是
//   这个文件，而不是镜像自带的默认配置）。
//
// 需要 docker 与 openssl。镜像 tag 由 CI 传入（CADDY_IMAGE / NGINX_IMAGE），这里不写默认值：
// 「验过的版本」以 .github/workflows/ci.yml 为准，改 tag 时按那里的注释同步各处文档。本地复跑：
//   CADDY_IMAGE=caddy:<tag> NGINX_IMAGE=nginx:<tag> node tools/reverse-proxy-check.mjs

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROBE_PATHS } from '../src/endpoints.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CADDYFILE_PATH = join(repoRoot, 'deploy', 'reverse-proxy', 'Caddyfile')
const NGINX_CONF_PATH = join(repoRoot, 'deploy', 'reverse-proxy', 'nginx.conf')
const README_PATH = join(repoRoot, 'deploy', 'README.md')

// 必须与 nginx.conf 里的 server_name 和 ssl_certificate 路径一致，否则容器里找不到证书。
const EXAMPLE_DOMAIN = 'signer.example.com'

// 占位值只用来让变量「存在」；不对应任何真实域名或上游。
const PLACEHOLDERS = {
    SIGNER_HOSTNAME: EXAMPLE_DOMAIN,
    LIBMSSDK_UPSTREAM: '127.0.0.1:8899',
}

let failures = 0

/**
 * 取出 Markdown 里 ```caddyfile 围起来的代码块，按出现顺序返回。
 * 围栏允许带缩进（示例常嵌在编号列表里），内容按围栏自身的缩进剥掉前缀。
 * 未闭合时报错：宁可让 CI 红，也不要静默跳过一段示例。
 */
export function extractCaddyfileBlocks(markdown, source = 'Markdown') {
    const blocks = []
    let fence = null
    const lines = markdown.split(/\r?\n/)

    lines.forEach((line, index) => {
        if (fence === null) {
            const opening = /^(\s*)```(.*)$/.exec(line)
            if (opening) fence = { indent: opening[1].length, language: opening[2].trim(), lines: [], line: index + 1 }
            return
        }
        if (/^\s*```\s*$/.test(line)) {
            if (fence.language === 'caddyfile') blocks.push(`${fence.lines.join('\n')}\n`)
            fence = null
            return
        }
        const leading = /^\s*/.exec(line)[0].length
        fence.lines.push(line.slice(Math.min(fence.indent, leading)))
    })

    if (fence !== null) {
        throw new Error(`${source} 第 ${fence.line} 行开始的代码块没有闭合`)
    }
    return blocks
}

/**
 * 从 nginx 配置里取出「关了访问日志的 location」覆盖的路径集合。
 *
 * 认仓库会用到的写法：精确匹配 `location = /livez`、普通前缀 `location /x`、前缀优先
 * `location ^~ /x`，以及正则 `location ~ ^/(livez|readyz|healthz)/?$`（`~*` 同理）。
 * 只收 body 里带 `access_log off` 的。正则不是 `^/(a|b...)/?$` 这一种可拆的写法时，原样
 * 收进集合（而不是忽略），这样对照会以「少了」暴露出来，而不是静默通过。
 */
export function nginxNoLogPaths(conf) {
    const paths = new Set()
    // 先剥掉 # 注释：注释里抄的那条 location 不是生效配置，不能拿来充数。
    const effective = conf.replace(/#.*$/gm, '')
    const locationPattern = /location\s+(=\s*|~\*?\s*|\^~\s*)?([^\s{]+)\s*\{([^}]*)\}/g
    for (const match of effective.matchAll(locationPattern)) {
        const [, operator = '', spec, body] = match
        if (!/\baccess_log\s+off\b/.test(body)) continue
        const kind = operator.trim()
        if (kind === '~' || kind === '~*') {
            // 认 `^/(a|b|c)$` 与尾斜杠可选的 `^/(a|b|c)/?$` 两种写法。
            const prefix = '^/('
            const suffix = [')$', ')/?$'].find(candidate => spec.startsWith(prefix) && spec.endsWith(candidate))
            if (suffix) {
                for (const name of spec.slice(prefix.length, -suffix.length).split('|')) {
                    paths.add(`/${name.trim()}`)
                }
            } else {
                paths.add(spec)
            }
            continue
        }
        if (spec.startsWith('/')) paths.add(spec)
    }
    return paths
}

/** 剥掉 Caddy 的行注释：`#` 在行首或空白之后都算（示例里没有把 # 写进路径的情况）。 */
function stripComment(line) {
    return line.replace(/(^|\s)#.*$/, '$1')
}

/** 把 Caddy 的引号正文（双引号与反引号）抹成空白，别让正文里的 `{`、数字干扰判断。 */
function maskQuoted(line) {
    return line.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, ' ')
}

/** 去掉注释与引号里的花括号后数括号：site block 才是 matcher 的作用域。 */
function braceDelta(line) {
    let delta = 0
    for (const char of maskQuoted(stripComment(line))) {
        if (char === '{') delta += 1
        else if (char === '}') delta -= 1
    }
    return delta
}

/** 把一个 caddyfile 代码块按顶层 `address { … }` 切开；块外的前导行忽略。 */
function splitCaddySiteBlocks(text) {
    const blocks = []
    let current = []
    let depth = 0
    for (const line of text.split('\n')) {
        const outsideBlock = depth === 0 && current.length === 0
        if (outsideBlock && !stripComment(line).includes('{')) continue
        current.push(line)
        depth += braceDelta(line)
        if (depth === 0) {
            blocks.push(current.join('\n'))
            current = []
        }
    }
    if (current.length > 0) blocks.push(current.join('\n'))
    return blocks
}

/**
 * 解析一个 site block 里的路径规则。
 *
 * Caddy 的命名 matcher 只在被指令引用的地方生效，作用域是单个 site block；所以调用方要先把
 * 代码块切成 site block。只认 `respond @name … 4xx` 引用到的 matcher（`respond` 默认 200，
 * 2xx/3xx 是正常应答，不是拦截）。定义形态决定语义：
 *   `@name not path /a /b` → 只放行 /a /b，其余 404（白名单）
 *   `@name path /a /b`     → 额外拦截 /a /b（从白名单里减掉）
 *
 * 返回 `{ allowlists, blocked, hasGate }`；没有 4xx 拦截引用时 `hasGate` 为 false，
 * 有拦截引用却没有 `not path` 白名单时 `allowlists` 为 null（无法核对，交给调用方报错）。
 */
export function parseCaddyPathRules(block) {
    const definitions = new Map()
    const denyReferences = []
    for (const raw of block.split('\n')) {
        const line = stripComment(raw).trim()
        const definition = /^(@[\w-]+)\s+(not\s+)?path\s+(.+)$/.exec(line)
        if (definition) {
            definitions.set(definition[1], {
                negated: Boolean(definition[2]),
                paths: definition[3].trim().split(/\s+/),
            })
            continue
        }
        const reference = /^respond\s+(@[\w-]+)\b(.*)$/.exec(line)
        if (!reference) continue
        // 引号（双引号/反引号）里可能写着「404 page」这类正文，不能当成状态码。
        const statuses = maskQuoted(reference[2]).match(/\b\d{3}\b/g)
        const status = statuses ? Number(statuses.at(-1)) : 200
        if (status >= 400) denyReferences.push(reference[1])
    }

    const allowlists = []
    const blocked = new Set()
    const unsupported = new Set()
    for (const name of denyReferences) {
        const definition = definitions.get(name)
        if (!definition) continue
        for (const path of definition.paths) {
            if (isUnsupportedPathPattern(path)) unsupported.add(path)
        }
        if (!definition.negated) {
            for (const path of definition.paths) blocked.add(path)
            continue
        }
        // 多条 not path 白名单取交集：每个 matcher 都把自己清单以外的路径 404 掉。
        allowlists.push(new Set(definition.paths))
    }
    return {
        allowlists: allowlists.length > 0 ? allowlists : null,
        blocked,
        unsupported: [...unsupported],
        hasGate: denyReferences.length > 0,
    }
}

/**
 * 只支持字面量路径与收尾 `*`（前缀匹配）。其余 Caddy 路径语法（`?`、字符类 `[]`、占位符
 * `{}`、`%` 转义、`//`、中间/开头的 `*`）不建模；遇到就判红而不是当字面量静默放过。
 */
function isUnsupportedPathPattern(pattern) {
    if (/[?[\]{}%]/.test(pattern) || pattern.includes('//')) return true
    const star = pattern.indexOf('*')
    return star !== -1 && star !== pattern.length - 1
}

/**
 * 支持的 Caddy `path` 语义：字面量精确匹配，或收尾 `*` 的前缀匹配；斜杠敏感、大小写不敏感。
 * 超出这个范围由 `isUnsupportedPathPattern` 负责判红，这里遇到只按不匹配处理。
 */
export function caddyPathMatches(pattern, path) {
    const wanted = pattern.toLowerCase()
    const actual = path.toLowerCase()
    if (!wanted.includes('*')) return wanted === actual
    if (wanted.endsWith('*') && !wanted.slice(0, -1).includes('*')) {
        return actual.startsWith(wanted.slice(0, -1))
    }
    return false
}

/** 某条路径是否被这份规则放行：命中每一条 `not path` 白名单，且不命中任何拦截模式。 */
export function pathAllowed(gate, path) {
    if (gate.allowlists === null) return false
    const inAllowlists = gate.allowlists.every(list =>
        [...list].some(pattern => caddyPathMatches(pattern, path)))
    const hitBlock = [...gate.blocked].some(pattern => caddyPathMatches(pattern, path))
    return inAllowlists && !hitBlock
}

/** 按 site block 返回路径规则，并记住它来自第几段代码块、第几个 site，供报错定位。 */
export function extractCaddyPathRules(markdown, source = 'Markdown') {
    return extractCaddyfileBlocks(markdown, source).flatMap((block, fenceIndex) =>
        splitCaddySiteBlocks(block).map((site, siteIndex) => ({
            ...parseCaddyPathRules(site),
            fence: fenceIndex + 1,
            site: siteIndex + 1,
        })))
}

/** Caddyfile 注释里的 log_skip 写法示例：`#   @probes path /livez /readyz /healthz`。 */
export function caddyLogSkipExamplePaths(caddyfile) {
    const match = /^\s*#\s*@probes\s+path\s+(.+)$/m.exec(caddyfile)
    return match ? match[1].trim().split(/\s+/) : null
}

/**
 * 结构对照固定跑这几项；main 逐项打印 ok/FAIL，npm test 直接看问题清单是否为空。
 * 名称写在这里而不是散在判断里，新增一项时两边都不会漏。
 *
 * 不建模 Caddy 的 log/log_skip 语义：log_skip 只收一个 matcher，写法不止一种，仓库原样也不开
 * log。这里只核对 Caddyfile 注释里给出的 `@probes path …` 示例与 PROBE_PATHS 是否一致，
 * 不判断 log 指令本身。
 */
export const STRUCTURE_CHECKS = Object.freeze({
    nginxProbes: 'nginx.conf：免访问日志的 location 覆盖全部探针',
    whitelist: 'deploy/README.md：白名单放行 /sign 与全部探针',
    statBlocked: 'deploy/README.md：白名单挡住 /stat',
    caddyPatterns: 'deploy/README.md：Caddy 路径写法在可核对范围内',
    caddyDoc: 'deploy/reverse-proxy/Caddyfile：log_skip 注释示例与探针清单一致',
})

/**
 * 反向代理示例与探针清单的结构对照，返回问题清单（空数组 = 通过）。
 *
 * nginx 与 README 白名单只查「覆盖」，多关一条日志（比如部署者顺手把 /stat 也关掉）是收紧，
 * 不该让 CI 红。Caddyfile 注释里的示例是清单抄本，必须与 PROBE_PATHS 逐项相等，多了少了都红。
 */
export function reverseProxyStructureProblems({ nginxConf, readme, caddyfile }) {
    const problems = []

    const nginxPaths = nginxNoLogPaths(nginxConf)
    const missingInNginx = PROBE_PATHS.filter(path => !nginxPaths.has(path))
    if (missingInNginx.length > 0) {
        problems.push({
            check: STRUCTURE_CHECKS.nginxProbes,
            detail: `少了：${missingInNginx.join(' ')}`,
        })
    }

    // Caddyfile 注释里的 log_skip 示例也是探针清单的一份抄本，同样要跟 PROBE_PATHS 对齐。
    const docPaths = caddyLogSkipExamplePaths(caddyfile)
    if (docPaths === null) {
        problems.push({
            check: STRUCTURE_CHECKS.caddyDoc,
            detail: '找不到注释里的 `@probes path …` 示例',
        })
    } else {
        const missingInDoc = PROBE_PATHS.filter(path => !docPaths.includes(path))
        const extraInDoc = docPaths.filter(path => !PROBE_PATHS.includes(path))
        if (missingInDoc.length > 0 || extraInDoc.length > 0) {
            problems.push({
                check: STRUCTURE_CHECKS.caddyDoc,
                detail: [
                    missingInDoc.length > 0 ? `少了：${missingInDoc.join(' ')}` : '',
                    extraInDoc.length > 0 ? `多了：${extraInDoc.join(' ')}` : '',
                ].filter(Boolean).join('\n'),
            })
        }
    }

    const gates = extractCaddyPathRules(readme).filter(rule => rule.hasGate)
    if (gates.length === 0) {
        problems.push({
            check: STRUCTURE_CHECKS.whitelist,
            detail: '找不到被 `respond … 4xx` 引用的 `not path` 放行 matcher，没法核对白名单',
        })
        problems.push({
            check: STRUCTURE_CHECKS.statBlocked,
            detail: '没有可核对的白名单示例',
        })
    }
    gates.forEach(gate => {
        const label = gates.length > 1 ? `第 ${gate.fence} 段示例第 ${gate.site} 个 site：` : ''
        if (gate.unsupported.length > 0) {
            // 能力边界写进返回码：超出可核对范围的写法一律判红，不能按字面量静默放过。
            problems.push({
                check: STRUCTURE_CHECKS.caddyPatterns,
                detail: `${label}超出可核对范围：${gate.unsupported.join(' ')}`,
            })
            problems.push({
                check: STRUCTURE_CHECKS.whitelist,
                detail: `${label}路径写法超出可核对范围，没法核对白名单`,
            })
            problems.push({
                check: STRUCTURE_CHECKS.statBlocked,
                detail: `${label}路径写法超出可核对范围，无法核对 /stat 是否被挡住`,
            })
            return
        }
        if (gate.allowlists === null) {
            problems.push({
                check: STRUCTURE_CHECKS.whitelist,
                detail: `${label}没有 \`not path\` 放行 matcher，没法核对白名单`,
            })
            problems.push({
                check: STRUCTURE_CHECKS.statBlocked,
                detail: `${label}白名单不可解析，无法核对 /stat 是否被挡住`,
            })
            return
        }
        // 按 Caddy path matcher 的语义判定，不是字面量查表：`/live*` 放行 /livez，`/stat*` 也放行 /stat。
        const missingInWhitelist = ['/sign', ...PROBE_PATHS].filter(path => !pathAllowed(gate, path))
        if (missingInWhitelist.length > 0) {
            problems.push({
                check: STRUCTURE_CHECKS.whitelist,
                detail: `${label}少了：${missingInWhitelist.join(' ')}`,
            })
        }
        // 示例的意图是「只放行签名与探针」：/stat 的计数会暴露使用情况，必须留在被挡的一侧。
        // 放行三条弃用回执是 #21 的事，与这里无关。
        if (pathAllowed(gate, '/stat')) {
            problems.push({
                check: STRUCTURE_CHECKS.statBlocked,
                detail: `${label}/stat 会暴露桶数、允许/拒绝与队列深度，该示例不该放行它`,
            })
        }
    })

    return problems
}

function indent(text) {
    return text
        .trim()
        .split('\n')
        .map((line) => `     ${line}`)
        .join('\n')
}

function report(name, ok, detail) {
    console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name}`)
    if (detail && detail.trim()) console.log(indent(detail))
    if (!ok) failures += 1
}

function withCommand(run, message) {
    return `命令：${run.command}\n${message}`
}

function expectPass(name, run) {
    if (run.status !== 0) {
        report(name, false, withCommand(run, `退出码 ${run.status}，输出：\n${run.output}`))
        return
    }
    report(name, true, run.output)
}

function expectFailureWithLocation(name, run, locationPattern) {
    if (run.status === 0) {
        report(name, false, withCommand(run, `预期校验失败，但它通过了，输出：\n${run.output}`))
        return
    }
    if (!locationPattern.test(run.output)) {
        report(name, false, withCommand(run, `失败信息没有指到文件:行（期望匹配 ${locationPattern}）：\n${run.output}`))
        return
    }
    report(name, true, run.output)
}

function docker(args) {
    const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    const command = ['docker', ...args].join(' ')
    if (result.error) throw new Error(`执行 docker 失败（需要本机有 docker）：${result.error.message}`)
    return {
        command,
        status: result.status,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    }
}

function caddyValidate(image, workDir, file, env) {
    const containerDir = '/w'
    const args = ['run', '--rm']
    for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`)
    args.push(
        '--volume', `${workDir}:${containerDir}:ro`,
        '--workdir', containerDir,
        image,
        'caddy', 'validate', '--config', `${containerDir}/${file}`, '--adapter', 'caddyfile',
    )
    return docker(args)
}

function nginxTest(image, workDir, confName, certDir) {
    return docker([
        'run', '--rm',
        '--volume', `${join(workDir, confName)}:/etc/nginx/conf.d/${confName}:ro`,
        '--volume', `${certDir}:/etc/letsencrypt/live/${EXAMPLE_DOMAIN}:ro`,
        image,
        'nginx', '-t',
    ])
}

function makeSelfSignedCert(certDir) {
    const result = spawnSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
        '-subj', `/CN=${EXAMPLE_DOMAIN}`,
        '-keyout', join(certDir, 'privkey.pem'),
        '-out', join(certDir, 'fullchain.pem'),
    ], { encoding: 'utf8' })
    if (result.error || result.status !== 0) {
        throw new Error(`生成临时证书失败（需要 openssl）：${result.error?.message ?? result.stderr}`)
    }
}

function main() {
    const caddyImage = process.env.CADDY_IMAGE
    const nginxImage = process.env.NGINX_IMAGE
    if (!caddyImage || !nginxImage) {
        throw new Error('必须提供 CADDY_IMAGE 与 NGINX_IMAGE（见 .github/workflows/ci.yml）')
    }

    const workDir = mkdtempSync(join(tmpdir(), 'libmssdk-proxy-'))
    // 各检查彼此独立、没有先后依赖：一项失败不跳过后面的，最后统一按失败数退出，
    // 这样一次 CI 就能把两份文件的问题都列出来。
    try {
        writeFileSync(join(workDir, 'Caddyfile'), readFileSync(CADDYFILE_PATH, 'utf8'))

        expectPass(
            'Caddyfile：两个变量都给了，validate 通过',
            caddyValidate(caddyImage, workDir, 'Caddyfile', PLACEHOLDERS),
        )

        const caddyLocation = /Caddyfile:\d+/
        const withoutPlaceholders = (...keys) =>
            Object.fromEntries(Object.entries(PLACEHOLDERS).filter(([key]) => !keys.includes(key)))
        for (const [label, env] of [
            ['缺 SIGNER_HOSTNAME', withoutPlaceholders('SIGNER_HOSTNAME')],
            ['缺 LIBMSSDK_UPSTREAM', withoutPlaceholders('LIBMSSDK_UPSTREAM')],
            ['两个变量都缺', withoutPlaceholders('SIGNER_HOSTNAME', 'LIBMSSDK_UPSTREAM')],
        ]) {
            expectFailureWithLocation(
                `Caddyfile：${label}时 validate 失败并指到行`,
                caddyValidate(caddyImage, workDir, 'Caddyfile', env),
                caddyLocation,
            )
        }

        const blocks = extractCaddyfileBlocks(readFileSync(README_PATH, 'utf8'), 'deploy/README.md')
        if (blocks.length === 0) {
            report('deploy/README.md 里的 caddyfile 示例', false, '一个 caddyfile 代码块都没找到')
        }
        blocks.forEach((block, index) => {
            const file = `readme-${index + 1}.caddyfile`
            writeFileSync(join(workDir, file), block)
            expectPass(
                `deploy/README.md 第 ${index + 1} 段 caddyfile 示例：validate 通过`,
                caddyValidate(caddyImage, workDir, file, PLACEHOLDERS),
            )
        })

        // 探针清单的唯一口径是 src/endpoints.mjs 的 PROBE_PATHS（/healthz 是 /readyz 的别名）。
        // nginx -t 只管语法：漏掉一个别名照样通过，高频探针却会照进取数日志。所以这里逐项对照。
        const structure = reverseProxyStructureProblems({
            nginxConf: readFileSync(NGINX_CONF_PATH, 'utf8'),
            readme: readFileSync(README_PATH, 'utf8'),
            caddyfile: readFileSync(CADDYFILE_PATH, 'utf8'),
        })
        for (const check of Object.values(STRUCTURE_CHECKS)) {
            const problems = structure.filter(item => item.check === check)
            if (problems.length === 0) report(check, true, '')
            else for (const problem of problems) report(check, false, problem.detail)
        }

        const certDir = join(workDir, 'certs', EXAMPLE_DOMAIN)
        mkdirSync(certDir, { recursive: true })
        makeSelfSignedCert(certDir)

        writeFileSync(join(workDir, 'libmssdk.conf'), readFileSync(NGINX_CONF_PATH, 'utf8'))
        expectPass(
            'nginx.conf：nginx -t 通过',
            nginxTest(nginxImage, workDir, 'libmssdk.conf', certDir),
        )

        const brokenPath = join(workDir, 'broken.conf')
        writeFileSync(brokenPath, `${readFileSync(NGINX_CONF_PATH, 'utf8')}\ndefinitely_not_a_directive on;\n`)
        expectFailureWithLocation(
            'nginx.conf：注入非法指令时 nginx -t 失败并指到行',
            nginxTest(nginxImage, workDir, 'broken.conf', certDir),
            /broken\.conf:\d+/,
        )
    } finally {
        rmSync(workDir, { recursive: true, force: true })
    }

    if (failures > 0) {
        throw new Error(`${failures} 项校验失败`)
    }
    console.log('\n反向代理示例配置校验通过。')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main()
    } catch (error) {
        console.error(`反向代理配置校验失败：${error.message}`)
        process.exitCode = 1
    }
}
