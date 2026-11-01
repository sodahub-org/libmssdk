#!/usr/bin/env node
// 反向代理示例配置的离线校验：仓库交付的两份配置在合入前就被验一遍语法。
//
// - Caddyfile：官方镜像里跑 `caddy validate`，变量齐全时须通过，缺任意一个变量时须失败，
//   且报错要指到具体行（不是一句 exit code）。
// - deploy/README.md 里标记为 caddyfile 的代码块（那段路径白名单示例）一起验。
// - nginx.conf：临时造一份自签证书，按官方镜像的 conf.d 用法跑 `nginx -t`（镜像自带的 nginx.conf
//   就是那个最小 `http {}` 外壳）；再注入一条非法指令，确认失败信息能指到行号（证明验的确实是
//   这个文件，而不是镜像自带的默认配置）。
//
// 需要 docker 与 openssl。镜像 tag 由 CI 传入（CADDY_IMAGE / NGINX_IMAGE），这里不写默认值：
// 「验过的版本」以 .github/workflows/ci.yml 为准，改 tag 时同步 deploy/README.md 与
// docs/DEPLOY-WINDOWS.md。本地复跑：
//   CADDY_IMAGE=caddy:<tag> NGINX_IMAGE=nginx:<tag> node tools/reverse-proxy-check.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CADDYFILE_PATH = join(repoRoot, 'deploy', 'reverse-proxy', 'Caddyfile');
const NGINX_CONF_PATH = join(repoRoot, 'deploy', 'reverse-proxy', 'nginx.conf');
const README_PATH = join(repoRoot, 'deploy', 'README.md');

// 占位值只用来让变量「存在」；不对应任何真实域名或上游。
const PLACEHOLDERS = {
  SIGNER_HOSTNAME: 'signer.example.com',
  LIBMSSDK_UPSTREAM: '127.0.0.1:8899',
};

let failures = 0;

/**
 * 取出 Markdown 里 ```caddyfile 围起来的代码块，按出现顺序返回。
 * 围栏允许带缩进（示例常嵌在编号列表里），内容按围栏自身的缩进剥掉前缀。
 * 未闭合时报错：宁可让 CI 红，也不要静默跳过一段示例。
 */
export function extractCaddyfileBlocks(markdown, source = 'Markdown') {
  const blocks = [];
  let fence = null;
  const lines = markdown.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (fence === null) {
      const opening = /^(\s*)```(.*)$/.exec(line);
      if (opening) fence = { indent: opening[1].length, language: opening[2].trim(), lines: [], line: index + 1 };
      return;
    }
    if (/^\s*```\s*$/.test(line)) {
      if (fence.language === 'caddyfile') blocks.push(`${fence.lines.join('\n')}\n`);
      fence = null;
      return;
    }
    const leading = /^\s*/.exec(line)[0].length;
    fence.lines.push(line.slice(Math.min(fence.indent, leading)));
  });

  if (fence !== null) {
    throw new Error(`${source} 第 ${fence.line} 行开始的代码块没有闭合`);
  }
  return blocks;
}

function indent(text) {
  return text
    .trim()
    .split('\n')
    .map((line) => `     ${line}`)
    .join('\n');
}

function report(name, ok, detail) {
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name}`);
  if (detail && detail.trim()) console.log(indent(detail));
  if (!ok) failures += 1;
}

function expectPass(name, run) {
  if (run.status !== 0) {
    report(name, false, `命令：${run.command}\n退出码 ${run.status}，输出：\n${run.output}`);
    return;
  }
  report(name, true, run.output);
}

function expectFailureWithLocation(name, run, locationPattern) {
  if (run.status === 0) {
    report(name, false, `命令：${run.command}\n预期校验失败，但它通过了，输出：\n${run.output}`);
    return;
  }
  if (!locationPattern.test(run.output)) {
    report(name, false, `命令：${run.command}\n失败信息没有指到文件:行（期望匹配 ${locationPattern}）：\n${run.output}`);
    return;
  }
  report(name, true, run.output);
}

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const command = ['docker', ...args].join(' ');
  if (result.error) throw new Error(`执行 docker 失败（需要本机有 docker）：${result.error.message}`);
  return {
    command,
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

function caddyValidate(image, workDir, file, env) {
  const args = ['run', '--rm'];
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
  args.push(
    '--volume', `${workDir}:/w:ro`,
    '--workdir', '/w',
    image,
    'caddy', 'validate', '--config', `/w/${file}`, '--adapter', 'caddyfile',
  );
  return docker(args);
}

function nginxTest(image, confPath, containerName, certDir) {
  return docker([
    'run', '--rm',
    '--volume', `${confPath}:/etc/nginx/conf.d/${containerName}:ro`,
    '--volume', `${certDir}:/etc/letsencrypt/live/signer.example.com:ro`,
    image,
    'nginx', '-t',
  ]);
}

function makeSelfSignedCert(certDir) {
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=signer.example.com',
    '-keyout', join(certDir, 'privkey.pem'),
    '-out', join(certDir, 'fullchain.pem'),
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`生成临时证书失败（需要 openssl）：${result.error?.message ?? result.stderr}`);
  }
}

function main() {
  const caddyImage = process.env.CADDY_IMAGE;
  const nginxImage = process.env.NGINX_IMAGE;
  if (!caddyImage || !nginxImage) {
    throw new Error('必须提供 CADDY_IMAGE 与 NGINX_IMAGE（见 .github/workflows/ci.yml）');
  }

  const workDir = mkdtempSync(join(tmpdir(), 'libmssdk-proxy-'));
  // 各检查彼此独立、没有先后依赖：一项失败不跳过后面的，最后统一按失败数退出，
  // 这样一次 CI 就能把两份文件的问题都列出来。
  try {
    writeFileSync(join(workDir, 'Caddyfile'), readFileSync(CADDYFILE_PATH, 'utf8'));

    expectPass(
      'Caddyfile：两个变量都给了，validate 通过',
      caddyValidate(caddyImage, workDir, 'Caddyfile', PLACEHOLDERS),
    );

    const caddyLocation = /Caddyfile:\d+/;
    for (const [label, env] of [
      ['缺 SIGNER_HOSTNAME', { LIBMSSDK_UPSTREAM: PLACEHOLDERS.LIBMSSDK_UPSTREAM }],
      ['缺 LIBMSSDK_UPSTREAM', { SIGNER_HOSTNAME: PLACEHOLDERS.SIGNER_HOSTNAME }],
      ['两个变量都缺', {}],
    ]) {
      expectFailureWithLocation(
        `Caddyfile：${label}时 validate 失败并指到行`,
        caddyValidate(caddyImage, workDir, 'Caddyfile', env),
        caddyLocation,
      );
    }

    const blocks = extractCaddyfileBlocks(readFileSync(README_PATH, 'utf8'), 'deploy/README.md');
    if (blocks.length === 0) {
      report('deploy/README.md 里的 caddyfile 示例', false, '一个 caddyfile 代码块都没找到');
    }
    blocks.forEach((block, index) => {
      const file = `readme-${index + 1}.caddyfile`;
      writeFileSync(join(workDir, file), block);
      expectPass(
        `deploy/README.md 第 ${index + 1} 段 caddyfile 示例：validate 通过`,
        caddyValidate(caddyImage, workDir, file, PLACEHOLDERS),
      );
    });

    const certDir = join(workDir, 'certs', 'signer.example.com');
    mkdirSync(certDir, { recursive: true });
    makeSelfSignedCert(certDir);

    writeFileSync(join(workDir, 'libmssdk.conf'), readFileSync(NGINX_CONF_PATH, 'utf8'));
    expectPass(
      'nginx.conf：nginx -t 通过',
      nginxTest(nginxImage, join(workDir, 'libmssdk.conf'), 'libmssdk.conf', certDir),
    );

    const brokenPath = join(workDir, 'broken.conf');
    writeFileSync(brokenPath, `${readFileSync(NGINX_CONF_PATH, 'utf8')}\ndefinitely_not_a_directive on;\n`);
    expectFailureWithLocation(
      'nginx.conf：注入非法指令时 nginx -t 失败并指到行',
      nginxTest(nginxImage, brokenPath, 'broken.conf', certDir),
      /broken\.conf:\d+/,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    throw new Error(`${failures} 项校验失败`);
  }
  console.log('\n反向代理示例配置校验通过。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`反向代理配置校验失败：${error.message}`);
    process.exitCode = 1;
  }
}
