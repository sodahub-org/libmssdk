import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractCaddyfileBlocks } from '../tools/reverse-proxy-check.mjs'

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
