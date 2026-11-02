'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const { materialize } = require('../lib/bundle');
const runtime = require('../lib/runtime');
const resolver = require('../lib/resolve');
const { writeUnifiedLauncher } = require('../lib/launchers');

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-deploy-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function fixture(directory, name, contents = name) {
  const source = path.join(directory, name);
  fs.writeFileSync(source, contents);
  return { name, source, algorithm: 'sha256', checksum: crypto.createHash('sha256').update(contents).digest('hex') };
}

test('Windows 一键安装脚本自动调用安装器，无需提供 CLI 命令名', { skip: process.platform !== 'win32' }, (t) => {
  const directory = scratch(t);
  fs.copyFileSync(path.join(__dirname, '../install.cmd'), path.join(directory, 'install.cmd'));
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.writeFileSync(path.join(directory, 'bin/buildervillager.js'),
    "require('node:fs').writeFileSync(require('node:path').join(__dirname, '../invocation.json'), JSON.stringify(process.argv.slice(2)));\n");
  const result = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `call "${path.join(directory, 'install.cmd')}"`],
    { encoding: 'utf8', timeout: 30_000, input: '', windowsHide: true, windowsVerbatimArguments: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const args = JSON.parse(fs.readFileSync(path.join(directory, 'invocation.json')));
  assert.deepEqual(args, ['--dir', path.join(directory, 'buildervillager-server'), '--no-interactive']);
});

test('一键启动执行两个服务入口，首次在脚本内确认 EULA', { skip: process.platform !== 'win32' }, (t) => {
  const directory = path.join(scratch(t), '启动 空格');
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, 'mcp'));
  fs.writeFileSync(path.join(directory, 'start-paper.cmd'), '@echo off\r\necho started>"%~dp0paper-started.txt"\r\n');
  fs.writeFileSync(path.join(directory, 'mcp/start.cmd'), '@echo off\r\necho started>"%~dp0mcp-started.txt"\r\n');
  fs.writeFileSync(path.join(directory, 'mcp/mcp.json'), '{"port":0}');
  fs.writeFileSync(path.join(directory, 'server.properties'), 'server-port=0\n');
  fs.writeFileSync(path.join(directory, 'eula.txt'), 'eula=false\n');
  writeUnifiedLauncher(directory);
  const harness = [
    '$global:Started = @()',
    "function Read-Host { return 'Y' }",
    'function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle); $global:Started += [pscustomobject]@{args=$ArgumentList;cwd=$WorkingDirectory;style=$WindowStyle}; $fixtureArgs = $ArgumentList -replace "/k ", "/c "; $child = Microsoft.PowerShell.Management\\Start-Process -FilePath $FilePath -ArgumentList $fixtureArgs -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -Wait -PassThru; if ($child.ExitCode -ne 0) { throw "Fixture launcher failed" } }',
    "& (Join-Path $PSScriptRoot 'start.ps1')",
    "$global:Started | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'started.json') -Encoding UTF8",
  ].join('\r\n');
  const harnessFile = path.join(directory, 'test.ps1');
  fs.writeFileSync(harnessFile, '\ufeff' + harness);
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessFile], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(path.join(directory, 'eula.txt'), 'utf8'), /eula=true/);
  const started = JSON.parse(fs.readFileSync(path.join(directory, 'started.json'), 'utf8').replace(/^\ufeff/, ''));
  assert.equal(started.length, 2);
  assert.ok(started[0].args.includes('start-paper.cmd'));
  assert.ok(started[1].args.includes('mcp\\start.cmd') || started[1].args.includes('mcp/start.cmd'));
  assert.ok(started.every((entry) => fs.realpathSync.native(entry.cwd).toLowerCase() === fs.realpathSync.native(directory).toLowerCase()));
  assert.ok(started.every((entry) => entry.style === 'Hidden'));
  assert.ok(fs.existsSync(path.join(directory, 'paper-started.txt')));
  assert.ok(fs.existsSync(path.join(directory, 'mcp/mcp-started.txt')));
  fs.writeFileSync(harnessFile, '\ufeff' + harness.replace("function Read-Host { return 'Y' }", "function Read-Host { throw 'EULA already accepted; must not prompt again' }"));
  const repeated = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessFile], { encoding:'utf8', windowsHide:true, timeout:30000 });
  assert.equal(repeated.status,0,repeated.stdout+repeated.stderr);
});

test('下载停滞会退出并清理临时文件，保留已有文件', async (t) => {
  const directory = scratch(t);
  const server = http.createServer((_, res) => { res.writeHead(200); res.write('partial'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const destination = path.join(directory, 'runtime.zip');
  fs.writeFileSync(destination, 'keep');
  await assert.rejects(require('../lib/util').download(`http://127.0.0.1:${server.address().port}`, destination,
    { idleTimeoutMs: 50 }), /下载超时/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'keep');
  assert.equal(fs.existsSync(`${destination}.download`), false);
});

test('随包资源损坏时拒绝复制，不覆盖现有目标', async (t) => {
  const directory = scratch(t);
  const artifact = fixture(directory, 'source.jar');
  const destination = path.join(directory, 'existing.jar');
  fs.writeFileSync(destination, 'keep');
  fs.appendFileSync(artifact.source, 'tampered');
  await assert.rejects(materialize(artifact, destination), /校验失败/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'keep');
});

test('运行库实际解压到带空格中文的目录，可复用，校验失败保留旧目录', async (t) => {
  const directory = scratch(t);
  const source = path.join(directory, 'tree');
  fs.mkdirSync(path.join(source, 'jdk', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(source, 'jdk', 'bin', 'fixture'), 'executable');
  const archive = path.join(directory, 'runtime.tar');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  assert.equal(spawnSync(tar, ['-cf', archive, '-C', source, '.']).status, 0);
  const artifact = { kind: 'jdk', name: 'runtime.tar', source: archive, algorithm: 'sha256',
    checksum: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') };
  const target = path.join(directory, '中文 空格', 'java');
  const executable = await runtime.installRuntime(artifact, target, 'fixture');
  assert.equal(fs.readFileSync(executable, 'utf8'), 'executable');
  assert.equal(await runtime.installRuntime({ ...artifact, source: 'missing' }, target, 'fixture'), executable);
  await assert.rejects(runtime.installRuntime(artifact, target, 'fixture', () => false), /没有可用/);
  assert.equal(fs.readFileSync(executable, 'utf8'), 'executable');
});

test('无 Java、无 Agent 时计划自动补齐，并完成服务、插件与启动脚本部署', async (t) => {
  const directory = scratch(t);
  const bundle = require('../lib/bundle');
  const install = require('../lib/install');
  const originals = [];
  const replace = (object, key, value) => {
    originals.push(() => { object[key] = value; });
    object[key] = value;
  };
  const artifacts = Object.fromEntries(['jdk', 'agent', 'paper', 'worldedit', 'worldguard'].map((key) =>
    [key, { ...fixture(directory, key === 'paper' ? 'paper-26.3-1.jar' : `${key}.jar`), kind: key, slug: key, version: 'test', build: 1 }]));
  replace(bundle, 'bundledArtifact', (key) => artifacts[key]);
  replace(resolver, 'javaExecutable', () => '');
  replace(resolver, 'javaMajor', (file) => file.includes('runtime') ? 25 : 0);
  replace(resolver, 'detectBackend', () => ({ backend: '', executable: '' }));
  replace(resolver, 'findOnPath', () => '');
  const runtimePath = (dir, name) => {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    const file = path.join(dir, 'bin', name);
    fs.writeFileSync(file, 'fixture');
    return file;
  };
  replace(runtime, 'installJava', async (_, dir) => runtimePath(dir, process.platform === 'win32' ? 'java.exe' : 'java'));
  replace(runtime, 'installCodex', async (_, dir) => runtimePath(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  replace(install, 'findBundledServer', () => ({ path: fixture(directory, 'buildervillager-mcp.jar').source }));
  replace(install, 'findBundledPlugin', () => ({ path: fixture(directory, 'buildervillager-paper.jar').source, name: 'buildervillager-paper.jar' }));
  const cliModule = require.resolve('../lib/cli');
  const cached = require.cache[cliModule];
  delete require.cache[cliModule];
  t.after(() => {
    originals.reverse().forEach((restore) => restore());
    if (cached) require.cache[cliModule] = cached;
    else delete require.cache[cliModule];
  });
  const cli = require('../lib/cli');
  const target = path.join(directory, '空白 server');
  const options = cli.parseArgs(['--dir', target, '--only', 'paper,plugins,mcp', '--backend', 'codex', '--no-interactive']);
  const state = await cli.plan(options);
  assert.deepEqual(state.problems, []);
  assert.ok(state.jdk);
  assert.ok(state.agent);
  assert.equal(fs.existsSync(target), false, '检查不得创建部署目录');
  await cli.main(['check', '--dir', target, '--only', 'paper,plugins,mcp', '--backend', 'codex', '--no-interactive']);
  assert.equal(fs.existsSync(target), false, '--check 不得安装运行库或写文件');
  await cli.apply(state, options);
  assert.equal(state.major, 25);
  assert.ok(state.executable.startsWith(target));
  for (const file of ['paper-26.3-1.jar', 'plugins/worldedit.jar', 'plugins/worldguard.jar', 'plugins/buildervillager-paper.jar',
    'mcp/buildervillager-mcp.jar', 'mcp/mcp.json', 'mcp/secret.txt', 'plugins/BuilderVillager/mcp.json', 'start-paper.cmd']) {
    assert.ok(fs.existsSync(path.join(target, file)), file);
  }
  assert.ok(fs.readFileSync(path.join(target, 'start-paper.cmd'), 'utf8').includes(state.java));
  assert.ok(fs.readFileSync(path.join(target, 'start-paper.cmd'), 'utf8').includes('paper-26.3-1.jar'));
  assert.ok(fs.existsSync(path.join(target, 'start.cmd')));
  assert.ok(fs.existsSync(path.join(target, 'start.ps1')));
  assert.ok(fs.readFileSync(path.join(target, 'mcp/start.cmd'), 'utf8').includes(state.java));
  const config = JSON.parse(fs.readFileSync(path.join(target, 'mcp/mcp.json')));
  assert.equal(config.agent.executable, state.executable);
  assert.equal(config.agent.enabled, true);
  const secret = fs.readFileSync(path.join(target, 'mcp/secret.txt'), 'utf8');
  const again = await cli.plan(options);
  assert.equal(again.jdk, null);
  assert.equal(again.agent, null);
  assert.equal(again.paper, null);
  assert.equal(again.worldedit.install, false);
  assert.equal(again.builderPlugin.install, false);
  await cli.apply(again, options);
  assert.equal(fs.readFileSync(path.join(target, 'mcp/secret.txt'), 'utf8'), secret);

  const deepseekOptions = cli.parseArgs(['--dir', path.join(directory, 'deepseek'), '--only', 'skills', '--backend', 'deepseek']);
  replace(resolver, 'findOnPath', () => '');
  const deepseekState = await cli.plan(deepseekOptions);
  assert.deepEqual(deepseekState.problems, []);
  assert.equal(deepseekState.agent.kind, 'deepseek');
  assert.equal(deepseekState.jdk, null, '只装技能不需要 Java');
});
