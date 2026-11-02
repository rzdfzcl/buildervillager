'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CliError, fetchJson, fetchText, log } = require('./util');
const { materialize } = require('./bundle');
const { javaMajor } = require('./resolve');

async function resolveJdk(platform = process.platform, arch = process.arch) {
  const os = { win32: 'windows', linux: 'linux', darwin: 'mac' }[platform];
  const architecture = { x64: 'x64', arm64: 'aarch64' }[arch];
  if (!os || !architecture) throw new CliError(`不支持自动安装 Java：${platform}/${arch}`);
  if (platform === 'win32') {
    const name = `microsoft-jdk-25-windows-${architecture}.zip`;
    const url = `https://aka.ms/download-jdk/${name}`;
    const checksum = (await fetchText(`${url}.sha256sum.txt`)).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new CliError('Microsoft JDK 缺少有效 SHA256 校验值');
    return { kind: 'jdk', platform, arch, name, url, algorithm: 'sha256', checksum: checksum.toLowerCase() };
  }
  const assets = await fetchJson(`https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=${architecture}&image_type=jdk&os=${os}&vendor=eclipse`);
  const asset = assets.find((item) => item.binary && item.binary.package);
  if (!asset) throw new CliError(`没有适用于 ${platform}/${arch} 的 JDK 25`);
  const file = asset.binary.package;
  return { kind: 'jdk', platform, arch, name: file.name, url: file.link, size: file.size, algorithm: 'sha256', checksum: file.checksum };
}

async function resolveAgent(platform = process.platform, arch = process.arch) {
  // The native npm distribution contains codex plus its auxiliary executables.
  const pkg = await fetchJson(`https://registry.npmjs.org/@openai/codex/latest`);
  const alias = pkg.optionalDependencies && pkg.optionalDependencies[`@openai/codex-${platform}-${arch}`];
  if (!alias) throw new CliError(`不支持自动安装 Codex：${platform}/${arch}`);
  const version = alias.slice(alias.lastIndexOf('@') + 1);
  const native = await fetchJson(`https://registry.npmjs.org/@openai/codex/${encodeURIComponent(version)}`);
  const integrity = native.dist.integrity;
  if (!integrity || !integrity.startsWith('sha512-')) throw new CliError('Codex 安装包缺少 SHA512 校验值');
  return { kind: 'agent', platform, arch, name: `codex-${version}.tgz`, url: native.dist.tarball, version: pkg.version,
    algorithm: 'sha512', checksum: Buffer.from(integrity.slice(7), 'base64').toString('hex') };
}

function findExecutable(directory, name) {
  if (!fs.existsSync(directory)) return '';
  if (name.includes('/') && fs.existsSync(path.join(directory, name))) return path.join(directory, name);
  const direct = path.join(directory, 'bin', name);
  if (fs.existsSync(direct)) return direct;
  const files = fs.readdirSync(directory, { withFileTypes: true });
  if (files.some((entry) => entry.isFile() && entry.name === name)) return path.join(directory, name);
  for (const entry of files) {
    if (!entry.isDirectory()) continue;
    const found = findExecutable(path.join(directory, entry.name), name);
    if (found) return found;
  }
  return '';
}

function extract(archive, directory) {
  let result;
  if (archive.endsWith('.zip') && process.platform === 'win32') {
    // Pass paths through the environment, never interpolate them into PowerShell code.
    result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:BV_ARCHIVE -DestinationPath $env:BV_EXTRACT -Force"],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, BV_ARCHIVE: archive, BV_EXTRACT: directory } });
  } else {
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    // Windows tar can lose non-ASCII absolute paths under an English system locale.
    // The working directory is passed as UTF-16 by CreateProcess; keep tar's arguments relative.
    result = spawnSync(tar, ['-xf', path.basename(archive), '-C', path.basename(directory)],
      { cwd: path.dirname(archive), encoding: 'utf8', windowsHide: true });
  }
  if (result.error || result.status !== 0) throw new CliError(`解压失败：${path.basename(archive)}`, result.error ? result.error.message : result.stderr);
}

async function installRuntime(artifact, directory, executableName, validate = () => true) {
  const current = findExecutable(directory, executableName);
  if (current && validate(current)) return current;
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(directory), '.runtime-'));
  const archive = path.join(staging, artifact.name);
  const unpacked = path.join(staging, 'unpacked');
  try {
    const label = { jdk: 'JDK 25', agent: 'Codex CLI', deepseek: 'DeepSeek Harness 与依赖' }[artifact.kind] || artifact.kind;
    log.step(`安装 ${label}（${artifact.source ? '随包资源' : '官方下载'}）`);
    await materialize(artifact, archive);
    fs.mkdirSync(unpacked);
    extract(archive, unpacked);
    const executable = findExecutable(unpacked, executableName);
    if (!executable || !validate(executable)) throw new CliError(`安装包中没有可用的 ${executableName}`);
    // Preserve a broken previous runtime; only replace it after validating the new one.
    if (fs.existsSync(directory)) fs.renameSync(directory, `${directory}.backup-${Date.now()}`);
    const relative = path.relative(unpacked, executable);
    fs.renameSync(unpacked, directory);
    return path.join(directory, relative);
  } finally {
    if (path.dirname(path.resolve(staging)) !== path.dirname(path.resolve(directory))) throw new CliError('临时运行库目录越界');
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function installJava(artifact, directory) {
  return installRuntime(artifact, directory, process.platform === 'win32' ? 'java.exe' : 'java', (file) => javaMajor(file) >= 25);
}

function installCodex(artifact, directory) {
  return installRuntime(artifact, directory, process.platform === 'win32' ? 'codex.exe' : 'codex', (file) => {
    const result = spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return !result.error && result.status === 0;
  });
}

async function installDeepSeek(directory, artifact) {
  if (artifact && artifact.source) {
    const entry = await installRuntime(artifact, directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js', (file) => {
      const result = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      return !result.error && result.status === 0;
    });
    const root = path.resolve(entry, '../../../../..');
    const node = path.join(root, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.copyFileSync(process.execPath, node);
    const launcher = path.join(root, process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
    if (process.platform === 'win32') {
      fs.writeFileSync(launcher, '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules/@deepseek-ai/dsh/lib/bin.js" %*\r\n');
    } else {
      fs.writeFileSync(launcher, '#!/bin/sh\nbase="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$base/node" "$base/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n', { mode: 0o755 });
    }
    const result = spawnSync(node, [entry, '--help'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (result.error || result.status !== 0) throw new CliError('Harness 依赖校验失败', result.stderr || result.error?.message);
    fs.writeFileSync(path.join(directory, '.ready.json'), JSON.stringify({ version: artifact.version, checksum: artifact.checksum }));
    return launcher;
  }
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean);
  const npmCli = candidates.find((file) => fs.existsSync(file) && /(?:npm|npx)-cli\.js$/.test(file));
  if (!npmCli) throw new CliError('无法定位当前 npx 的 npm 安装器');
  log.step('自动安装 DeepSeek Harness 及其依赖');
  const { spawn } = require('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli.replace(/npx-cli\.js$/, 'npm-cli.js'), 'install', '--prefix', directory,
      '--no-audit', '--no-fund', '@deepseek-ai/dsh@latest'], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new CliError(`DeepSeek Harness 安装失败（${code}）`)));
  });
  return path.join(directory, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
}

module.exports = { resolveJdk, resolveAgent, findExecutable, installRuntime, installJava, installCodex, installDeepSeek };
