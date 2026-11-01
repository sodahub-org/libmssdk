import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROBE_PATHS } from '../src/endpoints.mjs'
import {
    extractCaddyfileBlocks,
    extractCaddyWhitelistPaths,
    nginxNoLogPaths,
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

test('README 路径白名单：认 not path 与 path 两种写法', () => {
    const markdown = [
        '```caddyfile',
        'signer.example.com {',
        '    @deny not path /sign /livez /readyz /healthz',
        '    respond @deny 404',
        '    @only path /sign',
        '}',
        '```',
    ].join('\n')

    assert.deepEqual(extractCaddyWhitelistPaths(markdown), [
        '/sign', '/livez', '/readyz', '/healthz', '/sign',
    ])
})

test('仓库里的反代示例与 PROBE_PATHS 一致：新增别名漏改一处就红', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8')

    assert.deepEqual(
        [...nginxNoLogPaths(read('deploy/reverse-proxy/nginx.conf'))].sort(),
        [...PROBE_PATHS].sort(),
        'nginx.conf 的免日志 location 必须覆盖 /healthz 别名',
    )
    assert.deepEqual(
        new Set(extractCaddyWhitelistPaths(read('deploy/README.md'), 'deploy/README.md')),
        new Set(['/sign', ...PROBE_PATHS]),
        'README 白名单必须放行 /sign 与全部探针',
    )
    assert.equal(
        /^\s*log\b/m.test(read('deploy/reverse-proxy/Caddyfile')),
        false,
        'Caddyfile 默认不开访问日志，探针才不会进取数日志',
    )
})
