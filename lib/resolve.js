'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CliError, fetchJson, hashFileSync } = require('./util');

const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';
const MODRINTH_API = 'https://api.modrinth.com/v2';

/** Paper 从 v3 API 取指定版本的最新稳定构建；没有稳定构建时退回最新构建。 */
async function resolvePaper(minecraftVersion) {
  const builds = await fetchJson(`${PAPER_API}/versions/${encodeURIComponent(minecraftVersion)}/builds`);
  if (!Array.isArray(builds) || builds.length === 0) {
    throw new CliError(`Paper ${minecraftVersion} 没有可用构建`, '用 --minecraft 指定其他版本');
  }
  const stable = builds.filter((build) => build.channel === 'STABLE');
  const pool = stable.length > 0 ? stable : builds;
  const latest = pool.slice().sort((a, b) => Number(b.id) - Number(a.id))[0];
  const download = latest.downloads && (latest.downloads['server:default'] || Object.values(latest.downloads)[0]);
  if (!download || !download.url) throw new CliError(`Paper ${minecraftVersion} 构建 ${latest.id} 缺少下载地址`);
  return {
    kind: 'paper',
    name: download.name,
    version: minecraftVersion,
    build: Number(latest.id),
    channel: latest.channel,
    url: download.url,
    size: Number(download.size || 0),
    algorithm: 'sha256',
    checksum: String(download.checksums.sha256 || ''),
  };
}

/** WorldEdit / WorldGuard 走 Modrinth，取该版本最新 release。 */
async function resolveModrinth(slug, minecraftVersion) {
  const filter = encodeURIComponent(JSON.stringify([minecraftVersion]));
  const loaders = encodeURIComponent(JSON.stringify(['paper', 'bukkit', 'spigot']));
  const versions = await fetchJson(`${MODRINTH_API}/project/${slug}/version?game_versions=${filter}&loaders=${loaders}`);
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new CliError(`${slug} 没有适用于 ${minecraftVersion} 的插件版本`, '确认服务器版本或用 --minecraft 指定');
  }
  const releases = versions.filter((item) => item.version_type === 'release');
  const pool = releases.length > 0 ? releases : versions;
  const chosen = pool.slice().sort((a, b) => new Date(b.date_published) - new Date(a.date_published))[0];
  const file = (chosen.files || []).find((item) => item.primary) || (chosen.files || [])[0];
  if (!file || !file.url) throw new CliError(`${slug} ${chosen.version_number} 缺少下载文件`);
  const algorithm = file.hashes && file.hashes.sha512 ? 'sha512' : 'sha1';
  return {
    kind: 'plugin',
    slug,
    name: file.filename,
    version: String(chosen.version_number),
    url: file.url,
    size: Number(file.size || 0),
    algorithm,
    checksum: String((file.hashes && file.hashes[algorithm]) || ''),
  };
}

function javaExecutable(javaHome) {
  const candidates = [];
  if (javaHome) candidates.push(path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function javaMajor(executable) {
  if (!executable) return 0;
  const { spawnSync } = require('node:child_process');
  // JDK 把版本横幅写在 stderr，且退出码为 0；必须同时读取两路输出。
  const result = spawnSync(executable, ['-version'], { encoding: 'utf8' });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  const match = text.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return 0;
  const major = Number(match[1]);
  return major === 1 && match[2] ? Number(match[2]) : major;
}

/** 在 PATH 中按 PATHEXT 查找 CLI，Windows 上优先可执行包装而不是 sh 脚本。 */
function findOnPath(name, environment = process.env) {
  const pathValue = environment.PATH || environment.Path || '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const directory of pathValue.split(separator)) {
    if (!directory) continue;
    const trimmed = directory.trim().replace(/^"|"$/g, '');
    if (!trimmed) continue;
    for (const extension of extensions) {
      for (const suffix of [extension.toLowerCase(), extension]) {
        const candidate = path.join(trimmed, name + suffix);
        if (fs.existsSync(candidate)) return candidate;
      }
      if (process.platform !== 'win32' && fs.existsSync(path.join(trimmed, name))) return path.join(trimmed, name);
    }
  }
  return '';
}

function detectBackend(environment = process.env) {
  const harness = findOnPath('dsh', environment);
  const codex = findOnPath('codex', environment);
  if (harness) return { backend: 'deepseek', executable: harness, codex, harness };
  if (codex) return { backend: 'codex', executable: codex, codex, harness };
  return { backend: '', executable: '', codex, harness };
}

function skillRoot(backend, environment = process.env) {
  const home = os.homedir();
  if (backend === 'codex') {
    const base = environment.CODEX_HOME || path.join(home, '.codex');
    return path.join(base, 'skills');
  }
  const base = environment.DSH_HOME || path.join(home, '.dsh');
  return path.join(base, 'skills');
}

module.exports = {
  resolvePaper,
  resolveModrinth,
  javaExecutable,
  javaMajor,
  findOnPath,
  detectBackend,
  skillRoot,
  PAPER_API,
  MODRINTH_API,
};
