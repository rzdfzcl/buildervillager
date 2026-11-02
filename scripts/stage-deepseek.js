'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fetchJson, hashFileSync, writeAtomic, readJson } = require('../lib/util');

async function stageDeepSeek(vendor) {
  const previous = readJson(path.join(vendor, 'deepseek.json'));
  if (!process.argv.includes('--refresh') && previous && previous.format === 2 && previous.platform === process.platform && previous.arch === process.arch
    && await hashFileSync(path.join(vendor, previous.file)) === previous.checksum) return previous;
  const pkg = await fetchJson('https://registry.npmjs.org/@deepseek-ai/dsh/latest');
  const staging = path.join(__dirname, '..', '.stage', 'deepseek');
  fs.mkdirSync(staging, { recursive: true });
  writeAtomic(path.join(staging, 'package.json'), JSON.stringify({
    name: 'buildervillager-deepseek-runtime', version: pkg.version, private: true,
    dependencies: { '@deepseek-ai/dsh': pkg.version }, bundledDependencies: ['@deepseek-ai/dsh'],
  }, null, 2));
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  const npmCli = candidates.find((file) => fs.existsSync(file) && /(?:npm|npx)-cli\.js$/.test(file));
  if (!npmCli) throw new Error('无法找到 npm-cli.js，不能打包 Harness 依赖');
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli.replace(/npx-cli\.js$/, 'npm-cli.js'), ...args],
      { cwd: staging, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Harness 依赖打包失败：npm ${args[0]} (${code})`)));
  });
  await run(['install', '--omit=dev', '--no-audit', '--no-fund']);
  const downloads = path.join(vendor, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const name = `buildervillager-deepseek-runtime-${pkg.version}.tgz`;
  const archive = path.join(downloads, name);
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  // npm's bundledDependencies traversal can omit installed peer dependencies. Archive the complete installed tree.
  await new Promise((resolve, reject) => {
    const child = spawn(tar, ['-czf', archive, '-C', staging, 'package.json', 'node_modules'], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Harness 完整依赖归档失败 (${code})`)));
  });
  const artifact = { kind: 'deepseek', format: 2, platform: process.platform, arch: process.arch, name, version: pkg.version,
    file: `downloads/${name}`, algorithm: 'sha256', checksum: await hashFileSync(archive),
    url: 'https://registry.npmjs.org/@deepseek-ai/dsh', size: fs.statSync(archive).size };
  writeAtomic(path.join(vendor, 'deepseek.json'), JSON.stringify(artifact, null, 2));
  return artifact;
}

module.exports = { stageDeepSeek };

if (require.main === module) stageDeepSeek(path.join(__dirname, '..', 'vendor'))
  .then((artifact) => console.log(`Harness 完整依赖包已就绪：${artifact.name}`))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
