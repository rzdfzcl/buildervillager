'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CliError, log, download, hashFileSync, writeAtomic, readJson } = require('./util');

const SECRET_FILE = 'secret.txt';
const CONFIG_FILE = 'mcp.json';
const PAPER_FILE = 'paper-mcp.json';

function validSecret(value) {
  return typeof value === 'string'
    && value.length >= 32 && value.length <= 256
    && /^[\x21-\x7e]+$/.test(value);
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function findBundledServer() {
  const jar = path.join(__dirname, '..', 'vendor', 'buildervillager-mcp.jar');
  if (fs.existsSync(jar)) return { kind: 'jar', path: jar };
  // 仓库开发时的回退路径：直接使用 Gradle 构建产物。
  const directory = path.join(__dirname, '..', '..', 'mcp', 'build', 'libs');
  if (fs.existsSync(directory)) {
    const match = fs.readdirSync(directory)
      .filter((name) => /^buildervillager-mcp-.*\.jar$/.test(name))
      .sort((a, b) => fs.statSync(path.join(directory, b)).mtimeMs - fs.statSync(path.join(directory, a)).mtimeMs)[0];
    if (match) return { kind: 'jar', path: path.join(directory, match) };
  }
  throw new CliError('安装包缺少 MCP 服务程序', '这是打包问题：请重新安装 @rzdfzcl/buildervillager');
}

function findBundledSkills() {
  const root = path.join(__dirname, '..', 'vendor', 'skills');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name);
}

function skillResourceDirectories() {
  return [
    path.join(__dirname, '..', 'vendor', 'skills'),
    path.join(__dirname, '..', '..', 'src', 'main', 'resources', 'assets', 'buildervillager', 'skills'),
  ];
}

function bundledSkill(name) {
  for (const directory of skillResourceDirectories()) {
    const file = path.join(directory, name, 'SKILL.md');
    if (fs.existsSync(file)) return file;
  }
  return '';
}

async function installSkills(backend, target, { force } = {}) {
  if (!backend) return [];
  const names = findBundledSkills();
  const candidates = names.length > 0 ? names : ['buildervillager-construction', 'buildervillager-knowledge-curation'];
  const installed = [];
  for (const name of candidates) {
    const source = bundledSkill(name);
    if (!source) continue;
    const destination = path.join(target, name, 'SKILL.md');
    const same = fs.existsSync(destination)
      && (await hashFileSync(destination, 'sha256')) === (await hashFileSync(source, 'sha256'));
    if (same && !force) {
      log.skip(`技能 ${name} 已是最新`);
      installed.push(destination);
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.copyFileSync(source, temporary);
    fs.renameSync(temporary, destination);
    log.ok(`${fs.existsSync(destination) && same === false ? '更新' : '安装'}技能 ${name} → ${destination}`);
    installed.push(destination);
  }
  return installed;
}

/** 写 MCP 配置、共享密钥、Paper 片段与启动脚本；已有文件默认保留。 */
function writeService(options) {
  const {
    directory, serverFileName, backend, executable, port, bridgePort, concurrency, timeoutSeconds,
    secret, force, javaCommand,
  } = options;
  fs.mkdirSync(directory, { recursive: true });
  const desired = {
    bind: '127.0.0.1',
    port,
    publicUrl: `http://127.0.0.1:${port}/mcp`,
    allowedOrigins: [],
    bridgeUrl: `http://127.0.0.1:${bridgePort}/bridge`,
    agent: {
      enabled: Boolean(backend),
      backend: backend || 'codex',
      executable: executable || '',
      directory: 'agent-state',
      timeoutSeconds,
      concurrency,
    },
  };
  const configPath = path.join(directory, CONFIG_FILE);
  const previous = readJson(configPath, null);
  let configState = 'unchanged';
  if (!previous) {
    writeAtomic(configPath, `${JSON.stringify(desired, null, 2)}\n`);
    configState = 'created';
    log.ok(`写入 ${configPath}`);
  } else if (force || JSON.stringify(previous) === JSON.stringify(desired)) {
    if (force && JSON.stringify(previous) !== JSON.stringify(desired)) {
      writeAtomic(configPath, `${JSON.stringify(desired, null, 2)}\n`);
      configState = 'updated';
      log.ok(`更新 ${configPath}`);
    } else {
      log.skip('mcp.json 未变化');
    }
  } else {
    configState = 'preserved';
    log.warn(`保留现有 ${CONFIG_FILE}（与本次参数不同，需要覆盖时加 --force）`);
  }
  const secretPath = path.join(directory, SECRET_FILE);
  if (secret.generated) {
    writeAtomic(secretPath, `${secret.value}\n`);
    log.ok(`生成共享密钥 ${secretPath}`);
  } else {
    log.skip('secret.txt 已存在，保持不变');
  }
  const paperPath = path.join(directory, PAPER_FILE);
  writeAtomic(paperPath, `${JSON.stringify({
    enabled: true,
    port,
    publicUrl: `http://127.0.0.1:${port}/mcp`,
    bridgeBind: '127.0.0.1',
    bridgePort,
    bridgeSecret: secret.value,
  }, null, 2)}\n`);
  writeLaunchers(directory, serverFileName, javaCommand);
  return { configState, configPath, secretPath, paperPath };
}

function writeLaunchers(directory, serverFileName, javaCommand) {
  const java = javaCommand || 'java';
  const windows = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    `if not exist "%~dp0${SECRET_FILE}" (`,
    '  echo 缺少 secret.txt，请重新安装。',
    '  exit /b 1',
    ')',
    `set /p BUILDER_MCP_BRIDGE_SECRET=<"%~dp0${SECRET_FILE}"`,
    `"${java}" -jar "%~dp0${serverFileName}" --config "%~dp0${CONFIG_FILE}"`,
    '',
  ].join('\r\n');
  writeAtomic(path.join(directory, 'start.cmd'), windows);
  const powershell = [
    "$ErrorActionPreference = 'Stop'",
    'Set-Location -LiteralPath $PSScriptRoot',
    `if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot '${SECRET_FILE}'))) { throw '缺少 secret.txt，请重新安装。' }`,
    `$env:BUILDER_MCP_BRIDGE_SECRET = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '${SECRET_FILE}') -Raw).Trim()`,
    `& "${java}" -jar (Join-Path $PSScriptRoot '${serverFileName}') --config (Join-Path $PSScriptRoot '${CONFIG_FILE}')`,
    '',
  ].join('\n');
  writeAtomic(path.join(directory, 'start.ps1'), powershell);
}

async function ensureSecret(directory, { rotate } = {}) {
  const file = path.join(directory, SECRET_FILE);
  if (!rotate && fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (validSecret(existing)) return { value: existing, generated: false };
  }
  return { value: randomSecret(), generated: true };
}

module.exports = {
  findBundledServer,
  findBundledSkills,
  bundledSkill,
  installSkills,
  writeService,
  writeLaunchers,
  ensureSecret,
  validSecret,
  randomSecret,
  SECRET_FILE,
  CONFIG_FILE,
  PAPER_FILE,
};
