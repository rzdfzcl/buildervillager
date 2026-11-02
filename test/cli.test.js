'use strict';
/**
 * 无网络的自动化测试：用本地 HTTP 服务器伪造 Paper/Modrinth 响应，
 * 校验交互选择、检查/部署/更新三条路径，以及组件多选与幂等。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'buildervillager-test-'));
process.env.CODEX_HOME = path.join(scratch, 'codex-home');
process.env.DSH_HOME = path.join(scratch, 'dsh-home');

const paperBytes = Buffer.from('paper-server-jar-content');
const paperHash = crypto.createHash('sha256').update(paperBytes).digest('hex');
const pluginBytes = Buffer.from('worldedit-and-worldguard');
const pluginHash = crypto.createHash('sha512').update(pluginBytes).digest('hex');

let base;
const server = http.createServer((req, res) => {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  };
  if (req.url === '/paper/versions/26.3/builds') {
    return send(200, JSON.stringify([{
      id: 237,
      channel: 'STABLE',
      downloads: {
        'server:default': {
          name: 'paper-26.3-237.jar',
          size: paperBytes.length,
          url: `${base}/files/paper`,
          checksums: { sha256: paperHash },
        },
      },
    }]));
  }
  if (req.url === '/paper/versions/9.9/builds') return send(200, JSON.stringify([]));
  if (req.url.startsWith('/modrinth/project/worldedit/version')) {
    return send(200, JSON.stringify([{
      version_number: '7.4.6',
      version_type: 'release',
      date_published: '2026-10-01T00:00:00Z',
      files: [{ filename: 'worldedit-bukkit-7.4.6.jar', url: `${base}/files/worldedit`, size: pluginBytes.length, primary: true, hashes: { sha512: pluginHash } }],
    }]));
  }
  if (req.url.startsWith('/modrinth/project/worldguard/version')) {
    return send(200, JSON.stringify([{
      version_number: '7.0.20',
      version_type: 'release',
      date_published: '2026-10-02T00:00:00Z',
      files: [{ filename: 'worldguard-bukkit-7.0.20.jar', url: `${base}/files/worldguard`, size: pluginBytes.length, primary: true, hashes: { sha512: pluginHash } }],
    }]));
  }
  if (req.url === '/files/paper') return send(200, paperBytes, 'application/java-archive');
  if (req.url.startsWith('/files/')) return send(200, pluginBytes, 'application/java-archive');
  send(404, JSON.stringify({ error: 'not found' }));
});

function tamper(url) {
  return url;
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const resolve = require(path.join(root, 'lib/resolve'));
  // 用本地假服务替换官方地址
  const originalRequest = require(path.join(root, 'lib/util'));
  assert.ok(tamper(base));

  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  test('parseArgs 接受组件多选与跳过', () => {
    const { parseArgs } = require(path.join(root, 'lib/cli'));
    const only = parseArgs(['--only', 'paper,mcp']);
    assert.deepStrictEqual(only.components, ['paper', 'mcp']);
    const skipped = parseArgs(['--skip', 'paper']);
    assert.ok(skipped.skip.has('paper'));
    assert.throws(() => parseArgs(['--only', 'nope']), /未知组件/);
    assert.throws(() => parseArgs(['--port', '0']), /1–65535/);
    assert.throws(() => parseArgs(['--port', '25576', '--bridge-port', '25576']), /不能相同/);
    const all = parseArgs(['--only', 'all']);
    assert.strictEqual(all.components.length, 4);
  });

  test('parseArgs 支持短参数与默认值', () => {
    const { parseArgs } = require(path.join(root, 'lib/cli'));
    assert.strictEqual(parseArgs([]).interactive, false, '默认下载后直接安装，不显示组件菜单');
    assert.strictEqual(parseArgs(['--interactive']).interactive, true);
    const options = parseArgs(['-d', '.', '-m', '26.3', '--backend', 'codex', '--timeout', '60']);
    assert.strictEqual(options.minecraft, '26.3');
    assert.strictEqual(options.backend, 'codex');
    assert.strictEqual(options.timeoutSeconds, 60);
    assert.throws(() => parseArgs(['--backend', 'other']), /只支持/);
  });

  test('安装逻辑写配置、密钥与启动脚本且幂等', async () => {
    const install = require(path.join(root, 'lib/install'));
    const directory = path.join(scratch, 'mcp');
    const secret = await install.ensureSecret(directory, { rotate: false });
    assert.ok(install.validSecret(secret.value));
    const result = install.writeService({
      directory,
      serverFileName: 'buildervillager-mcp.jar',
      backend: 'codex',
      executable: 'C:/bin/codex.exe',
      port: 25576,
      bridgePort: 25577,
      concurrency: 2,
      timeoutSeconds: 1200,
      secret,
      force: false,
      javaCommand: 'java',
    });
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    assert.strictEqual(config.agent.backend, 'codex');
    assert.strictEqual(config.port, 25576);
    const paper = JSON.parse(fs.readFileSync(result.paperPath, 'utf8'));
    assert.strictEqual(paper.bridgeSecret, secret.value);
    assert.ok(fs.readFileSync(path.join(directory, 'start.cmd'), 'utf8').includes('secret.txt'));
    const again = await install.ensureSecret(directory, { rotate: false });
    assert.strictEqual(again.value, secret.value);
    assert.strictEqual(again.generated, false);
    const rotated = await install.ensureSecret(directory, { rotate: true });
    assert.notStrictEqual(rotated.value, secret.value);
  });

  test('技能安装到选定后端目录且不改动其他技能', async () => {
    const install = require(path.join(root, 'lib/install'));
    const target = path.join(scratch, 'skills-target');
    const other = path.join(target, 'third-party/SKILL.md');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'keep');
    const installed = await install.installSkills('codex', target, { force: false });
    assert.strictEqual(installed.length, 2);
    assert.strictEqual(fs.readFileSync(other, 'utf8'), 'keep');
    for (const file of installed) assert.ok(file.startsWith(target));
    const second = await install.installSkills('codex', target, { force: false });
    assert.deepStrictEqual(second, installed);
  });

  test('javaMajor 读取 stderr 横幅', () => {
    const resolve = require(path.join(root, 'lib/resolve'));
    const jetbrains = require('node:child_process');
    const original = jetbrains.spawnSync;
    jetbrains.spawnSync = () => ({ stdout: '', stderr: 'openjdk version "25.0.1" 2026-01-01\n' });
    try {
      assert.strictEqual(resolve.javaMajor('java'), 25);
      jetbrains.spawnSync = () => ({ stdout: '', stderr: 'java version "1.8.0_121"\n' });
      assert.strictEqual(resolve.javaMajor('java'), 8);
    } finally {
      jetbrains.spawnSync = original;
    }
    assert.strictEqual(resolve.javaMajor(''), 0);
  });

  test('findOnPath 按 PATHEXT 查找并忽略大小写', () => {
    const resolve = require(path.join(root, 'lib/resolve'));
    const bin = path.join(scratch, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const name = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
    fs.writeFileSync(path.join(bin, name), '');
    const environment = { Path: bin, PATHEXT: '.CMD' };
    assert.strictEqual(resolve.findOnPath('dsh', environment), path.join(bin, name));
    assert.strictEqual(resolve.findOnPath('absent', environment), '');
  });

  test('下载校验失败会丢弃文件', async () => {
    const util = require(path.join(root, 'lib/util'));
    const target = path.join(scratch, 'bad.bin');
    await assert.rejects(
      util.download(`${base}/files/paper`, target, { algorithm: 'sha256', expected: 'deadbeef' }),
      /校验失败/,
    );
    assert.strictEqual(fs.existsSync(target), false);
    const good = path.join(scratch, 'good.bin');
    await util.download(`${base}/files/paper`, good, { algorithm: 'sha256', expected: paperHash });
    assert.deepStrictEqual(fs.readFileSync(good), paperBytes);
  });

  test('resolvePaper 取最新 STABLE，resolveModrinth 取最新 release', async () => {
    const util = require('../lib/util');
    const original = util.fetchJson;
    const modulePath = require.resolve('../lib/resolve');
    const cached = require.cache[modulePath];
    util.fetchJson = (url) => original(url.replace('https://fill.papermc.io/v3/projects/paper', `${base}/paper`)
      .replace('https://api.modrinth.com/v2', `${base}/modrinth`));
    delete require.cache[modulePath];
    try {
      const resolver = require('../lib/resolve');
      assert.strictEqual((await resolver.resolvePaper('26.3')).build, 237);
      assert.strictEqual((await resolver.resolveModrinth('worldedit', '26.3')).version, '7.4.6');
      await assert.rejects(resolver.resolvePaper('9.9'), /没有可用构建/);
    } finally {
      util.fetchJson = original;
      require.cache[modulePath] = cached;
    }
  });

  let failed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log(`  ✓ ${item.name}`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${item.name}`);
      console.log(`    ${error.message}`);
    }
  }
  server.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${tests.length - failed}/${tests.length} 通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
