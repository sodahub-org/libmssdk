import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
    extractCaddyfileBlocks,
    extractCaddyPathRules,
    nginxNoLogPaths,
    reverseProxyStructureProblems,
} from '../tools/reverse-proxy-check.mjs'

test('只提取 caddyfile 代码块，别的语言原样略过', () => {
    const markdown = [
        '前言',
        '```bash',
        'echo hi',
        '```',
        '```caddyfile',
        'signer.example.com {',
        '    reverse_proxy 127.0.0.1:8899',
        '}',
        '```',
        '尾巴',
    ].join('\n')

    assert.deepEqual(extractCaddyfileBlocks(markdown), [
        'signer.example.com {\n    reverse_proxy 127.0.0.1:8899\n}\n',
    ])
})

test('多个 caddyfile 代码块按出现顺序返回，CRLF 也认', () => {
    const markdown = [
        '```caddyfile',
        'a.example.com {',
        '}',
        '```',
        '```caddyfile',
        'b.example.com {',
        '}',
        '```',
    ].join('\r\n')

    assert.deepEqual(extractCaddyfileBlocks(markdown), [
        'a.example.com {\n}\n',
        'b.example.com {\n}\n',
    ])
})

test('列表里缩进的代码块也能取到，并按围栏的缩进剥掉前缀', () => {
    const markdown = [
        '8. 想收紧就在反代里只放行签名与探针：',
        '',
        '   ```caddyfile',
        '   signer.example.com {',
        '       reverse_proxy {',
        '           to {$LIBMSSDK_UPSTREAM}',
        '       }',
        '   }',
        '   ```',
        '   后面还有正文。',
    ].join('\n')

    assert.deepEqual(extractCaddyfileBlocks(markdown), [
        'signer.example.com {\n    reverse_proxy {\n        to {$LIBMSSDK_UPSTREAM}\n    }\n}\n',
    ])
})

test('没有 caddyfile 代码块时返回空数组', () => {
    const markdown = ['```bash', 'echo hi', '```'].join('\n')
    assert.deepEqual(extractCaddyfileBlocks(markdown), [])
})

test('代码块没闭合时报错，而不是静默跳过', () => {
    assert.throws(
        () => extractCaddyfileBlocks('```caddyfile\nfoo {\n'),
        /Markdown 第 1 行开始的代码块没有闭合/,
    )
    assert.throws(
        () => extractCaddyfileBlocks('```caddyfile\nfoo {\n', 'deploy/README.md'),
        /deploy\/README\.md 第 1 行开始的代码块没有闭合/,
    )
})

test('nginx 正则 location：取出关了访问日志的全部探针', () => {
    const conf = [
        'server {',
        '    location ~ ^/(livez|readyz|healthz)/?$ { access_log off; proxy_pass http://libmssdk; }',
        '    location / { proxy_pass http://libmssdk; }',
        '}',
    ].join('\n')

    assert.deepEqual([...nginxNoLogPaths(conf)].sort(), ['/healthz', '/livez', '/readyz'])
})

test('nginx 精确 location：多个名字都收，没关日志的不收', () => {
    const conf = [
        'location = /livez  { access_log off; proxy_pass http://libmssdk; }',
        'location = /readyz { access_log off; proxy_pass http://libmssdk; }',
        'location = /stat   { proxy_pass http://libmssdk; }',
    ].join('\n')

    assert.deepEqual([...nginxNoLogPaths(conf)].sort(), ['/livez', '/readyz'])
})

test('nginx 注释掉的 location 不算数：不许拿注释充免日志清单', () => {
    const conf = [
        '# location ~ ^/(livez|readyz|healthz)$ { access_log off; proxy_pass http://libmssdk; }',
        'location / { proxy_pass http://libmssdk; }',
    ].join('\n')

    assert.deepEqual([...nginxNoLogPaths(conf)], [])
})

test('README 路径规则：只认 respond 引用的 matcher，未被引用的不算', () => {
    const markdown = [
        '```caddyfile',
        'signer.example.com {',
        '    @deny not path /sign /livez /readyz /healthz  # 只放行这些',
        '    respond @deny 404',
        '    @only path /sign',
        '    @probes path /healthz',
        '}',
        '```',
    ].join('\n')

    const [rules] = extractCaddyPathRules(markdown)
    assert.deepEqual(rules.allowed, new Set(['/sign', '/livez', '/readyz', '/healthz']))
    assert.deepEqual(rules.blocked, new Set(), '@only 与 @probes 没被 respond 引用，不进规则')
})

test('README 路径规则：respond 引用的 path matcher 是额外拦截，不是放行', () => {
    const markdown = [
        '```caddyfile',
        'signer.example.com {',
        '    @deny not path /sign /livez /readyz /healthz',
        '    respond @deny 404',
        '    @blocked path /stat',
        '    respond @blocked 404',
        '}',
        '```',
    ].join('\n')

    const [rules] = extractCaddyPathRules(markdown)
    assert.equal(rules.allowed.has('/stat'), false)
    assert.equal(rules.blocked.has('/stat'), true)
})

test('README 路径规则：respond 200 是正常应答，不算拦截', () => {
    const markdown = [
        '```caddyfile',
        'signer.example.com {',
        '    @deny not path /sign /livez /readyz /healthz',
        '    respond @deny 404',
        '    @open path /stat',
        '    respond @open 200',
        '}',
        '```',
    ].join('\n')

    const [rules] = extractCaddyPathRules(markdown)
    assert.equal(rules.blocked.has('/stat'), false, 'respond 200 不是拦截')
})

test('README 路径规则按代码块隔离：后一段白名单补不了前一段的漏项', () => {
    const markdown = [
        '```caddyfile',
        'first.example.com {',
        '    @deny not path /sign /livez /readyz',
        '    respond @deny 404',
        '}',
        '```',
        '```caddyfile',
        'second.example.com {',
        '    @deny not path /sign /livez /readyz /healthz',
        '    respond @deny 404',
        '}',
        '```',
    ].join('\n')

    const [first, second] = extractCaddyPathRules(markdown)
    assert.equal(first.allowed.has('/healthz'), false)
    assert.equal(second.allowed.has('/healthz'), true)

    const nginxConf = 'location ~ ^/(livez|readyz|healthz)$ { access_log off; proxy_pass http://libmssdk; }'
    const problems = reverseProxyStructureProblems({ nginxConf, readme: markdown })
    assert.deepEqual(problems.map(p => p.check), ['deploy/README.md：白名单放行 /sign 与全部探针'])
    assert.match(problems[0].detail, /第 1 段/)
    assert.match(problems[0].detail, /\/healthz/)
})

test('README 路径规则按 site block 隔离：同一段里的第二个 site 补不了第一个的漏项', () => {
    const markdown = [
        '```caddyfile',
        'strict.example.com {',
        '    @deny not path /sign /livez /readyz',
        '    respond @deny 404',
        '}',
        'loose.example.com {',
        '    @deny not path /sign /livez /readyz /healthz',
        '    respond @deny 404',
        '}',
        '```',
    ].join('\n')

    const [strict, loose] = extractCaddyPathRules(markdown)
    assert.equal(strict.allowed.has('/healthz'), false)
    assert.equal(loose.allowed.has('/healthz'), true)

    const nginxConf = 'location ~ ^/(livez|readyz|healthz)$ { access_log off; proxy_pass http://libmssdk; }'
    const problems = reverseProxyStructureProblems({ nginxConf, readme: markdown })
    assert.deepEqual(problems.map(p => p.check), ['deploy/README.md：白名单放行 /sign 与全部探针'])
    assert.match(problems[0].detail, /第 1 段示例第 1 个 site/)
    assert.match(problems[0].detail, /\/healthz/)
})

test('README 路径规则：respond 引号里的 404 正文不算状态码', () => {
    const markdown = [
        '```caddyfile',
        'example.com {',
        '    @deny not path /sign /livez /readyz /healthz',
        '    respond @deny "404 page"',
        '}',
        '```',
    ].join('\n')

    const [rules] = extractCaddyPathRules(markdown)
    assert.equal(rules.hasGate, false, '没有状态码就是默认 200，不是拦截')
})

test('README 路径规则：respond 反引号里的 404 正文也不算状态码', () => {
    const markdown = [
        '```caddyfile',
        'example.com {',
        '    @deny not path /sign /livez /readyz /healthz',
        '    respond @deny `404 page`',
        '}',
        '```',
    ].join('\n')

    const [rules] = extractCaddyPathRules(markdown)
    assert.equal(rules.hasGate, false, '反引号正文不是状态码，默认 200')
})

test('README 路径规则：行首注释里的花括号不参与 site block 切分', () => {
    const markdown = [
        '```caddyfile',
        '# 只放行签名与探针 {注意后面的 404',
        'strict.example.com {',
        '    @deny not path /sign /livez /readyz',
        '    respond @deny 404',
        '}',
        'loose.example.com {',
        '    @deny not path /sign /livez /readyz /healthz',
        '    respond @deny 404',
        '}',
        '```',
    ].join('\n')

    const [strict, loose] = extractCaddyPathRules(markdown)
    assert.equal(strict.allowed.has('/healthz'), false)
    assert.equal(loose.allowed.has('/healthz'), true)

    const nginxConf = 'location ~ ^/(livez|readyz|healthz)$ { access_log off; proxy_pass http://libmssdk; }'
    const problems = reverseProxyStructureProblems({ nginxConf, readme: markdown })
    assert.deepEqual(problems.map(p => p.check), ['deploy/README.md：白名单放行 /sign 与全部探针'])
    assert.match(problems[0].detail, /\/healthz/)
})

test('结构对照：多段示例的问题都要报出来，不能只留第一条', () => {
    const nginxConf = 'location ~ ^/(livez|readyz|healthz)$ { access_log off; proxy_pass http://libmssdk; }'
    const readme = [
        '```caddyfile',
        'first.example.com {',
        '    @deny not path /sign /livez /readyz',
        '    respond @deny 404',
        '}',
        '```',
        '```caddyfile',
        'second.example.com {',
        '    @deny not path /sign /livez',
        '    respond @deny 404',
        '}',
        '```',
    ].join('\n')

    const problems = reverseProxyStructureProblems({ nginxConf, readme }).filter(
        p => p.check === 'deploy/README.md：白名单放行 /sign 与全部探针',
    )
    assert.equal(problems.length, 2)
    assert.match(problems[0].detail, /第 1 段示例第 1 个 site/)
    assert.match(problems[1].detail, /第 2 段示例第 1 个 site/)
})

test('仓库里的反代示例与 PROBE_PATHS 一致：新增别名漏改一处就红', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8')

    assert.deepEqual(
        reverseProxyStructureProblems({
            nginxConf: read('deploy/reverse-proxy/nginx.conf'),
            readme: read('deploy/README.md'),
        }),
        [],
    )
})

test('结构对照只查覆盖：nginx 多关一条日志不算问题，白名单挡住 /stat 才算', () => {
    const nginxConf = [
        'location ~ ^/(livez|readyz|healthz)$ { access_log off; proxy_pass http://libmssdk; }',
        'location = /stat { access_log off; proxy_pass http://libmssdk; }',
    ].join('\n')
    const readme = [
        '```caddyfile',
        'example.com {',
        '    @deny not path /sign /livez /readyz /healthz',
        '    respond @deny 404',
        '}',
        '```',
    ].join('\n')

    assert.deepEqual(
        reverseProxyStructureProblems({ nginxConf, readme }),
        [],
        '多关一条 /stat 是收紧，不该失败',
    )

    const withStat = readme.replace('/sign /livez', '/sign /stat /livez')
    assert.deepEqual(
        reverseProxyStructureProblems({ nginxConf, readme: withStat }).map(p => p.check),
        ['deploy/README.md：白名单挡住 /stat'],
    )
})

test('结构对照看的是 respond 引用的白名单：@probes 补不出漏掉的别名', () => {
    const nginxConf = 'location ~ ^/(livez|readyz|healthz)$ { access_log off; proxy_pass http://libmssdk; }'
    const readme = [
        '```caddyfile',
        'example.com {',
        '    @probes path /livez /readyz /healthz',
        '    log_skip @probes',
        '    @deny not path /sign /livez /readyz',
        '    respond @deny 404',
        '}',
        '```',
    ].join('\n')

    const problems = reverseProxyStructureProblems({ nginxConf, readme })
    assert.deepEqual(problems.map(p => p.check), ['deploy/README.md：白名单放行 /sign 与全部探针'])
    assert.match(problems[0].detail, /\/healthz/)
})

test('结构对照：白名单用一个未被 respond 引用的 matcher 时明显报错', () => {
    const nginxConf = 'location ~ ^/(livez|readyz|healthz)$ { access_log off; proxy_pass http://libmssdk; }'
    const readme = [
        '```caddyfile',
        'example.com {',
        '    @deny not path /sign /livez /readyz /healthz',
        '}',
        '```',
    ].join('\n')

    assert.deepEqual(
        reverseProxyStructureProblems({ nginxConf, readme }).map(p => p.check),
        ['deploy/README.md：白名单放行 /sign 与全部探针', 'deploy/README.md：白名单挡住 /stat'],
        '没有可核对的示例时两项都不能显示成 ok',
    )
})
