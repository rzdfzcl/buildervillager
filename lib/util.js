'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

const USER_AGENT = 'buildervillager-cli/1.0';

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (supportsColor ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const color = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
};

const log = {
  title: (text) => console.log(color.bold(color.cyan(text))),
  step: (text) => console.log(`  ${text}`),
  ok: (text) => console.log(`  ${color.green('✓')} ${text}`),
  skip: (text) => console.log(`  ${color.dim('·')} ${color.dim(text)}`),
  warn: (text) => console.log(`  ${color.yellow('!')} ${text}`),
  fail: (text) => console.log(`  ${color.red('✗')} ${text}`),
  section: (text) => { console.log(''); console.log(color.cyan(`== ${text} ==`)); },
};

class CliError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http:') ? http : https;
    const req = client.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new CliError(`重定向次数过多：${url}`));
        return resolve(request(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (status !== 200) {
        res.resume();
        return reject(new CliError(`请求失败 HTTP ${status}：${url}`));
      }
      resolve(res);
    });
    req.on('error', (error) => reject(new CliError(`网络请求失败：${error.message}`, '检查代理或网络连接')));
    req.setTimeout(60_000, () => req.destroy(new CliError(`请求超时：${url}`)));
  });
}

async function fetchText(url) {
  const res = await request(url);
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchJson(url) {
  const text = await fetchText(url);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`返回内容不是合法 JSON：${url}`);
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function download(url, destination, options = {}) {
  const { algorithm = 'sha256', expected = '', onProgress } = options;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.download`;
  fs.rmSync(temporary, { force: true });
  const res = await request(url);
  const total = Number(res.headers['content-length'] || 0);
  let received = 0;
  let lastTick = 0;
  const sink = fs.createWriteStream(temporary);
  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (onProgress && total && now - lastTick > 120) {
        lastTick = now;
        onProgress(received, total);
      }
    });
    res.on('error', reject);
    sink.on('error', reject);
    sink.on('finish', resolve);
    res.pipe(sink);
  });
  if (expected) {
    const actual = await hashFile(temporary, algorithm);
    if (actual !== String(expected).toLowerCase()) {
      fs.rmSync(temporary, { force: true });
      throw new CliError(
        `校验失败：${path.basename(destination)}（${algorithm}）`,
        '下载内容与官方记录不一致，已丢弃；可重试或检查网络是否被代理篡改',
      );
    }
  }
  fs.rmSync(destination, { force: true });
  fs.renameSync(temporary, destination);
  return { size: received };
}

function hashFile(file, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function hashFileSync(file, algorithm = 'sha256') {
  if (!file || !fs.existsSync(file)) return '';
  return hashFile(file, algorithm);
}

function writeAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, target);
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function listJars(directory, pattern) {
  if (!fs.existsSync(directory)) return [];
  const matcher = new RegExp(pattern);
  return fs.readdirSync(directory)
    .filter((name) => matcher.test(name) && name.endsWith('.jar'))
    .map((name) => path.join(directory, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function isWindows() {
  return process.platform === 'win32';
}

function executableName(base) {
  return isWindows() ? `${base}.exe` : base;
}

module.exports = {
  CliError,
  color,
  log,
  request,
  fetchText,
  fetchJson,
  download,
  hashFile,
  hashFileSync,
  writeAtomic,
  readJson,
  expandHome,
  listJars,
  formatBytes,
  isWindows,
  executableName,
  USER_AGENT,
};
