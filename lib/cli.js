'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CliError, color, log, hashFileSync, writeAtomic, readJson, listJars, formatBytes } = require('./util');
const { resolvePaper, resolveModrinth, javaExecutable, javaMajor } = require('./resolve');
const {
  findBundledServer, findBundledPlugin, installSkills, writeService, ensureSecret, validSecret, SECRET_FILE,
} = require('./install');
const { skillRoot, detectBackend } = require('./resolve');
const { multiSelect } = require('./prompt');
const { bundledArtifact, materialize } = require('./bundle');
const { resolveJdk, resolveAgent, findExecutable, installCodex, installJava, installDeepSeek } = require('./runtime');
const { writeUnifiedLauncher } = require('./launchers');
const { installPanel } = require('./panel');

const DEFAULTS = {
  minecraft: '26.3',
  port: 25576,
  bridgePort: 25577,
  concurrency: 2,
  timeoutSeconds: 1200,
};

const COMPONENTS = [
  { key: 'paper', label: 'Paper 26.3 服务端', hint: 'paper-26.3-<构建>.jar' },
  { key: 'plugins', label: '必要插件（WorldEdit + WorldGuard）', hint: '26.3 最新 release' },
  { key: 'mcp', label: 'MCP 服务', hint: 'buildervillager-mcp + 配置 + 共享密钥' },
  { key: 'skills', label: 'Agent 技能', hint: 'buildervillager-construction / knowledge-curation' },
];

function componentEnabled(options, key) {
  return options.components.includes(key);
}

/** 未显式选择组件时：命令行 -skip 生效；否则进入多选，非 TTY 则默认全选。 */
async function resolveComponents(options) {
  if (options.components.length > 0) return options.components;
  const preselected = COMPONENTS
    .map((component, index) => (options.skip.has(component.key) ? -1 : index))
    .filter((index) => index >= 0);
  const picked = await multiSelect('选择要处理的组件（空格勾选 / 回车确认 / a 全选）', COMPONENTS, {
    preselected: preselected.length > 0 ? preselected : COMPONENTS.map((_, index) => index),
    allowEmpty: false,
  });
  if (picked === null) throw new CliError('已取消', '未做任何改动');
  if (picked.length === 0) throw new CliError('至少选择一个组件');
  return picked.map((index) => COMPONENTS[index].key);
}

function parseArgs(argv) {
  const options = {
    command: 'install',
    directory: path.join(process.cwd(), 'buildervillager-server'),
    minecraft: DEFAULTS.minecraft,
    port: DEFAULTS.port,
    bridgePort: DEFAULTS.bridgePort,
    concurrency: DEFAULTS.concurrency,
    timeoutSeconds: DEFAULTS.timeoutSeconds,
    backend: '',
    executable: '',
    javaHome: '',
    check: false,
    force: false,
    eula: false,
    only: '',
    skip: new Set(),
    components: [],
    interactive: false,
    rotateSecret: false,
    printSecret: false,
  };
  const commands = new Set(['install', 'update', 'check', 'status', 'skills', 'doctor']);
  let index = 0;
  if (argv.length > 0 && commands.has(argv[0])) {
    options.command = argv[0];
    index = 1;
  }
  const numeric = (flag, value, minimum, maximum) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new CliError(`${flag} 需要 ${minimum}–${maximum} 的整数`, `收到：${value}`);
    }
    return parsed;
  };
  const take = (flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError(`${flag} 缺少值`);
    index += 1;
    return value;
  };
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--dir': case '-d': options.directory = path.resolve(take(arg)); break;
      case '--minecraft': case '-m': options.minecraft = take(arg); break;
      case '--port': options.port = numeric(arg, take(arg), 1, 65535); break;
      case '--bridge-port': options.bridgePort = numeric(arg, take(arg), 1, 65535); break;
      case '--concurrency': options.concurrency = numeric(arg, take(arg), 1, 4); break;
      case '--timeout': options.timeoutSeconds = numeric(arg, take(arg), 10, 1500); break;
      case '--backend': {
        const value = take(arg);
        if (!['codex', 'deepseek'].includes(value)) throw new CliError('--backend 只支持 codex 或 deepseek');
        options.backend = value;
        break;
      }
      case '--executable': options.executable = take(arg); break;
      case '--java-home': options.javaHome = take(arg); break;
      case '--check': case '--dry-run': options.check = true; break;
      case '--force': options.force = true; break;
      case '--eula': case '--accept-eula': options.eula = true; break;
      case '--only': {
        const value = take(arg);
        const keys = value.split(/[\s,]+/).filter(Boolean);
        for (const key of keys) {
          if (key === 'all') { options.components = COMPONENTS.map((component) => component.key); continue; }
          if (!COMPONENTS.some((component) => component.key === key)) {
            throw new CliError(`未知组件：${key}`, `可用：${COMPONENTS.map((component) => component.key).join(' / ')} / all`);
          }
          if (!options.components.includes(key)) options.components.push(key);
        }
        break;
      }
      case '--skip': {
        const value = take(arg);
        for (const key of value.split(/[\s,]+/).filter(Boolean)) {
          if (!COMPONENTS.some((component) => component.key === key)) {
            throw new CliError(`未知组件：${key}`, `可用：${COMPONENTS.map((component) => component.key).join(' / ')}`);
          }
          options.skip.add(key);
        }
        break;
      }
      case '--skip-paper': options.skip.add('paper'); break;
      case '--skip-plugins': options.skip.add('plugins'); break;
      case '--skip-mcp': options.skip.add('mcp'); break;
      case '--skip-skills': options.skip.add('skills'); break;
      case '--no-interactive': options.interactive = false; break;
      case '--interactive': options.interactive = true; break;
      case '--rotate-secret': options.rotateSecret = true; break;
      case '--print-secret': options.printSecret = true; break;
      case '--version': case '-v': options.command = 'version'; break;
      case '--help': case '-h': options.command = 'help'; break;
      default:
        throw new CliError(`未知参数：${arg}`, '运行 buildervillager --help 查看全部参数');
    }
  }
  if (options.port === options.bridgePort) throw new CliError('--port 与 --bridge-port 不能相同');
  if (options.command === 'check') options.check = true;
  return options;
}

function paths(directory) {
  return {
    directory,
    plugins: path.join(directory, 'plugins'),
    mcp: path.join(directory, 'mcp'),
    manifest: path.join(directory, '.buildervillager.json'),
    paperConfig: path.join(directory, 'plugins', 'BuilderVillager', 'mcp.json'),
    eula: path.join(directory, 'eula.txt'),
    properties: path.join(directory, 'server.properties'),
  };
}

function findPaper(directory, minecraft) {
  return listJars(directory, `^paper-${minecraft.replace(/\./g, '\\.')}-\\d+\\.jar$`)[0] || '';
}

function findPlugin(directory, prefix) {
  return listJars(path.join(directory, 'plugins'), `^${prefix}.*\\.jar$`)[0] || '';
}

async function plan(options) {
  const target = paths(options.directory);
  const localJava = findExecutable(path.join(target.directory, 'runtime', 'java'), process.platform === 'win32' ? 'java.exe' : 'java');
  const detectedJava = javaExecutable(options.javaHome);
  const java = options.javaHome && detectedJava && javaMajor(detectedJava) >= 25 ? detectedJava
    : localJava && javaMajor(localJava) >= 25 ? localJava : detectedJava;
  const major = javaMajor(java);
  const detected = options.backend
    ? { backend: options.backend, executable: options.executable || require('./resolve').findOnPath(options.backend === 'deepseek' ? 'dsh' : 'codex') }
    : detectBackend();
  const backend = options.backend || detected.backend || 'deepseek';
  const executableCandidate = options.executable || detected.executable || (backend === 'codex'
    ? findExecutable(path.join(target.directory, 'runtime', 'agent'), process.platform === 'win32' ? 'codex.exe' : 'codex')
    : fs.existsSync(path.join(target.directory, 'runtime', 'deepseek', '.ready.json'))
      ? findExecutable(path.join(target.directory, 'runtime', 'deepseek'), process.platform === 'win32' ? 'dsh.cmd' : 'dsh') : '');
  const executable = executableCandidate && fs.existsSync(executableCandidate) ? executableCandidate : '';
  const items = [];
  const problems = [];
  const wantPaper = componentEnabled(options, 'paper');
  const wantPlugins = componentEnabled(options, 'plugins');
  const wantMcp = componentEnabled(options, 'mcp');
  const wantSkills = componentEnabled(options, 'skills');

  const needsJava = wantPaper || wantPlugins || wantMcp;
  let jdk = null;
  let agent = null;
  if (needsJava && major < 25) {
    try { jdk = bundledArtifact('jdk') || await resolveJdk(); }
    catch (error) { problems.push(error.message); }
  }
  if ((wantMcp || wantSkills) && !executable) {
    if (backend === 'codex') {
      try { agent = bundledArtifact('agent') || await resolveAgent(); }
      catch (error) { problems.push(error.message); }
      items.push({ part: 'Agent', name: 'Codex CLI', current: '未安装', desired: 'runtime/agent', action: '自动安装' });
    } else {
      agent = bundledArtifact('deepseek') || { kind: 'deepseek' };
      items.push({ part: 'Agent', name: 'DeepSeek Harness', current: '未安装', desired: 'runtime/deepseek', action: '自动安装' });
    }
  }

  let paper = null;
  let worldedit = null;
  let worldguard = null;
  if (wantPaper || wantPlugins) {
    try {
      if (wantPaper) paper = bundledArtifact('paper', options.minecraft) || await resolvePaper(options.minecraft);
      if (wantPlugins) {
        worldedit = bundledArtifact('worldedit', options.minecraft) || await resolveModrinth('worldedit', options.minecraft);
        worldguard = bundledArtifact('worldguard', options.minecraft) || await resolveModrinth('worldguard', options.minecraft);
      }
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (paper) {
    const current = findPaper(options.directory, options.minecraft);
    const currentName = current ? path.basename(current) : '未安装';
    const same = currentName === paper.name && await hashFileSync(current, paper.algorithm) === paper.checksum;
    items.push({ part: 'Paper', name: `服务端 ${options.minecraft}`, current: currentName, desired: paper.name, action: same && !options.force ? '已是最新' : current ? '更新' : '安装' });
    if (same && !options.force) paper = null;
  }
  for (const [label, plugin, prefix] of [['WorldEdit', worldedit, 'worldedit'], ['WorldGuard', worldguard, 'worldguard']]) {
    if (!plugin) continue;
    const current = findPlugin(options.directory, prefix);
    const currentName = current ? path.basename(current) : '未安装';
    const same = currentName === plugin.name && await hashFileSync(current, plugin.algorithm) === plugin.checksum;
    items.push({ part: '插件', name: label, current: currentName, desired: plugin.name, action: same && !options.force ? '已是最新' : current ? '更新' : '安装' });
    plugin.install = !same || options.force;
    plugin.current = current;
  }

  const bundled = wantMcp ? findBundledServer() : null;
  const builderPlugin = wantPlugins ? findBundledPlugin() : null;
  if (builderPlugin) {
    const destination = path.join(target.plugins, builderPlugin.name);
    builderPlugin.install = options.force || await hashFileSync(destination) !== await hashFileSync(builderPlugin.path);
    items.push({ part: '插件', name: 'BuilderVillager', current: fs.existsSync(destination) ? '已安装' : '未安装', desired: builderPlugin.name, action: builderPlugin.install ? '安装/更新' : '已是最新' });
  }
  if (wantMcp) {
    if (!bundled) problems.push('安装包缺少 MCP 服务程序，请重新 npm 安装');
    else {
      const name = path.basename(bundled.path);
      const installed = path.join(target.mcp, name);
      const sourceHash = await hashFileSync(bundled.path, 'sha256');
      const installedHash = await hashFileSync(installed, 'sha256');
      const action = !installedHash ? '安装' : installedHash !== sourceHash ? '更新' : options.force ? '重新部署' : '已是最新';
      items.push({ part: 'MCP', name: '服务程序', current: installedHash ? name : '未安装', desired: name, action });
      bundled.install = action !== '已是最新' || options.force;
      const secretPath = path.join(target.mcp, SECRET_FILE);
      items.push({ part: 'MCP', name: '共享密钥', current: fs.existsSync(secretPath) ? SECRET_FILE : '未生成', desired: SECRET_FILE, action: fs.existsSync(secretPath) && !options.rotateSecret ? (bundled.install ? '复用' : '已是最新') : '生成' });
      items.push({ part: 'MCP', name: 'Paper 侧配置', current: fs.existsSync(target.paperConfig) ? '已存在' : '未生成', desired: 'plugins/BuilderVillager/mcp.json', action: fs.existsSync(target.paperConfig) && !options.force ? (bundled.install ? '保留' : '已是最新') : '写入' });
    }
  }
  const skillTarget = wantSkills ? skillRoot(backend) : '';
  if (wantSkills) {
    if (!backend) items.push({ part: '技能', name: 'Agent 技能', current: '未探测到 CLI', desired: 'codex 或 deepseek', action: '跳过' });
    else if (skillTarget) {
      for (const name of ['buildervillager-construction', 'buildervillager-knowledge-curation']) {
        const destination = path.join(skillTarget, name, 'SKILL.md');
        const exists = fs.existsSync(destination);
        items.push({ part: '技能', name, current: exists ? '已安装' : '未安装', desired: backend, action: exists && !options.force ? '已是最新' : exists ? '更新' : '安装' });
      }
    } else {
      problems.push('未探测到 CLI：安装 codex 或 dsh，或用 --backend 与 --executable 指定');
    }
  }
  return {
    target, java, major, jdk, agent, backend, executable, paper, worldedit, worldguard, items, problems, bundled, builderPlugin, skillTarget,
    components: options.components.slice(),
  };
}

function printPlan(state, options) {
  log.section('检查结果');
  const rows = [
    ['Java', 'JDK 25', state.java ? `${state.java} (Java ${state.major})` : '未找到', 'Java 25', state.major >= 25 ? '就绪' : state.jdk ? '自动安装' : '需要安装'],
    ...state.items.map((item) => [item.part, item.name, item.current, item.desired, item.action]),
  ];
  const widths = [0, 1, 2, 3].map((column) => Math.max(...rows.map((row) => String(row[column]).length)));
  for (const row of rows) {
    console.log(`  ${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2].padEnd(widths[2])}  ${row[3].padEnd(widths[3])}  ${color.dim(row[4])}`);
  }
  if (state.items.every((item) => item.action === '已是最新') && state.major >= 25) {
    log.section('完成');
    log.ok('全部组件已是最新，无需改动');
  }
}

 const EULA_LINE = /^\s*eula\s*=\s*(true|false)\s*$/im;

function eulaAccepted(file) {
  if (!fs.existsSync(file)) return false;
  const match = fs.readFileSync(file, 'utf8').match(EULA_LINE);
  return Boolean(match) && match[1].toLowerCase() === 'true';
}

function ensureScaffold(state, options) {
  const target = state.target;
  fs.mkdirSync(target.directory, { recursive: true });
  const wantsPaper = componentEnabled(options, 'paper');
  if (!wantsPaper && !componentEnabled(options, 'plugins')) return;
  if (!fs.existsSync(target.properties)) {
    writeAtomic(target.properties, [
      'online-mode=true',
      'motd=BuilderVillager Paper server',
      'max-players=20',
      'view-distance=10',
      'simulation-distance=10',
      '',
    ].join('\r\n'));
    log.ok('创建 server.properties（默认值，可自行修改）');
  }
  const accepted = options.eula || eulaAccepted(target.eula);
  const text = `# 由 buildervillager 创建。eula=true 表示你同意 https://aka.ms/MinecraftEULA\r\neula=${accepted ? 'true' : 'false'}\r\n`;
  if (!fs.existsSync(target.eula)) {
    writeAtomic(target.eula, text);
    log.warn('已创建 eula.txt（eula=false）：确认同意 EULA 后改为 true，或重新运行并加 --eula');
  } else if (accepted && !eulaAccepted(target.eula)) {
    const existing = fs.readFileSync(target.eula, 'utf8');
    writeAtomic(target.eula, existing.replace(EULA_LINE, 'eula=true'));
    log.ok('已把 eula.txt 置为 true');
  } else if (accepted) {
    log.skip('EULA 已接受');
  }
  const paper = findPaper(target.directory, options.minecraft);
  const memory = readJson(path.join(target.directory, '.panel-settings.json'), {});
  const minMemory = Number.isInteger(memory.minMemoryGb) && memory.minMemoryGb >= 1 && memory.minMemoryGb <= 128 ? memory.minMemoryGb : 2;
  const maxMemory = Number.isInteger(memory.maxMemoryGb) && memory.maxMemoryGb >= minMemory && memory.maxMemoryGb <= 128 ? memory.maxMemoryGb : Math.max(4, minMemory);
  const launcher = path.join(target.directory, 'start-paper.cmd');
  writeAtomic(launcher, [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'cd /d "%~dp0"',
    'rem Paper 的内部共享密钥优先从环境变量读取，值来自 mcp\\secret.txt',
    'if exist "%~dp0mcp\\secret.txt" set /p BUILDER_MCP_BRIDGE_SECRET=<"%~dp0mcp\\secret.txt"',
    'if not exist "%~dp0logs" mkdir "%~dp0logs"',
    `"${state.java || 'java'}" -Xms${minMemory}G -Xmx${maxMemory}G -jar "%~dp0${state.paper ? state.paper.name : paper ? path.basename(paper) : 'paper.jar'}" --nogui >> "%~dp0logs\\panel-console.log" 2>&1`,
    '',
  ].join('\r\n'));
}

async function apply(state, options) {
  const target = state.target;
  if (state.jdk) {
    state.java = await installJava(state.jdk, path.join(target.directory, 'runtime', 'java'));
    state.major = javaMajor(state.java);
  }
  if (state.agent) {
    state.executable = state.agent.kind === 'deepseek'
      ? await installDeepSeek(path.join(target.directory, 'runtime', 'deepseek'), state.agent)
      : await installCodex(state.agent, path.join(target.directory, 'runtime', 'agent'));
  }
  ensureScaffold(state, options);
  if (state.paper) {
    const destination = path.join(target.directory, state.paper.name);
    log.step(`${state.paper.source ? '释放' : '下载'} Paper ${options.minecraft} 构建 ${state.paper.build}（${formatBytes(state.paper.size)}）`);
    await materialize(state.paper, destination);
    process.stdout.write('\r');
    for (const file of listJars(target.directory, `^paper-${options.minecraft.replace(/\./g, '\\.')}-\\d+\\.jar$`)) {
      if (file !== destination) fs.rmSync(file, { force: true });
    }
    log.ok(`Paper ${path.basename(destination)}`);
  }
  for (const plugin of [state.worldedit, state.worldguard]) {
    if (!plugin || !plugin.install) continue;
    fs.mkdirSync(target.plugins, { recursive: true });
    const destination = path.join(target.plugins, plugin.name);
    log.step(`${plugin.source ? '释放' : '下载'} ${plugin.slug} ${plugin.version}（${formatBytes(plugin.size)}）`);
    await materialize(plugin, destination);
    if (plugin.current && plugin.current !== destination) fs.rmSync(plugin.current, { force: true });
    for (const file of listJars(target.plugins, `^${plugin.slug}-.*\\.jar$`)) {
      if (file !== destination) fs.rmSync(file, { force: true });
    }
    log.ok(`${plugin.slug} ${path.basename(destination)}`);
  }
  if (state.builderPlugin && state.builderPlugin.install) {
    fs.mkdirSync(target.plugins, { recursive: true });
    fs.copyFileSync(state.builderPlugin.path, path.join(target.plugins, state.builderPlugin.name));
    for (const file of listJars(target.plugins, '^buildervillager-paper-.*\\.jar$')) fs.rmSync(file);
    log.ok('BuilderVillager Paper 插件');
  }
  let mcpWritten = false;
  if (componentEnabled(options, 'mcp') && state.bundled) {
    fs.mkdirSync(target.mcp, { recursive: true });
    const name = path.basename(state.bundled.path);
    const destination = path.join(target.mcp, name);
    if (state.bundled.install) {
      fs.copyFileSync(state.bundled.path, destination);
      log.ok(`MCP 服务 ${name}`);
    } else {
      log.skip('MCP 服务已是最新');
    }
    const secret = await ensureSecret(target.mcp, { rotate: options.rotateSecret });
    const result = writeService({
      directory: target.mcp,
      serverFileName: name,
      backend: state.backend,
      executable: state.executable,
      port: options.port,
      bridgePort: options.bridgePort,
      concurrency: options.concurrency,
      timeoutSeconds: options.timeoutSeconds,
      secret,
      force: options.force,
      javaCommand: state.java,
    });
    if (options.printSecret || secret.generated) log.step(`共享密钥：${secret.value}`);
    if (!fs.existsSync(target.paperConfig) || options.force) {
      fs.mkdirSync(path.dirname(target.paperConfig), { recursive: true });
      fs.copyFileSync(result.paperPath, target.paperConfig);
      log.ok(`Paper 侧配置 ${target.paperConfig}`);
    } else {
      log.skip('Paper 侧 mcp.json 已存在，保留');
    }
    mcpWritten = true;
  }
  if (componentEnabled(options, 'skills') && state.skillTarget) {
    const installed = await installSkills(state.backend, state.skillTarget, { force: options.force });
    if (installed.length === 0) log.warn('没有安装技能：安装包缺少技能资源');
  }
  const manifest = readJson(target.manifest, null) || {};
  if (state.paper) manifest.paper = { build: state.paper.build, file: state.paper.name, sha256: state.paper.checksum };
  if (state.worldedit && state.worldedit.install) manifest.worldedit = { file: state.worldedit.name, version: state.worldedit.version };
  if (state.worldguard && state.worldguard.install) manifest.worldguard = { file: state.worldguard.name, version: state.worldguard.version };
  if (mcpWritten) manifest.mcp = { file: path.basename(state.bundled.path) };
  if (state.backend) manifest.backend = state.backend;
  if (state.skillTarget) manifest.skills = state.skillTarget;
  manifest.minecraft = options.minecraft;
  manifest.updatedAt = new Date().toISOString();
  writeAtomic(target.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  if (findPaper(target.directory, options.minecraft) && fs.existsSync(path.join(target.mcp, 'start.cmd'))) {
    writeUnifiedLauncher(target.directory);
    installPanel(target.directory);
  }
}

function printNextSteps(state, options) {
  const target = state.target;
  log.section('完成');
  console.log(`  目录      ${target.directory}`);
  const paper = findPaper(target.directory, options.minecraft);
  console.log(`  Paper     ${paper ? path.basename(paper) : '未安装'}`);
  const worldedit = findPlugin(target.directory, 'worldedit');
  const worldguard = findPlugin(target.directory, 'worldguard');
  console.log(`  WorldEdit ${worldedit ? path.basename(worldedit) : '未安装'}`);
  console.log(`  WorldGuard ${worldguard ? path.basename(worldguard) : '未安装'}`);
  console.log(`  MCP       ${fs.existsSync(target.mcp) ? 'mcp/' : '未部署'}`);
  console.log(`  技能      ${state.skillTarget || '未启用 Agent'}`);
  log.section('下一步');
  console.log(`  管理面板：${path.join(target.directory, 'panel.cmd')}`);
  if (state.agent) console.log(state.backend === 'deepseek'
    ? `  首次使用 Harness：运行 "${state.executable}"，按提示配置模型账户`
    : `  首次使用 Codex：运行 "${state.executable}" login 完成账户登录`);
  console.log(`  一键启动 Paper + MCP：${path.join(target.directory, 'start.cmd')}`);
  if (!eulaAccepted(target.eula)) console.log('  首次启动时会提示确认 Minecraft EULA，无需手动编辑文件。');
  console.log('  游戏内：模组配置 → 建筑 MCP → 确认地址（自动连接）→ 测试 MCP');
}

async function status(options) {
  const state = await plan({ ...options, check: true, force: false });
  printPlan(state, options);
  const manifest = readJson(state.target.manifest, null);
  if (manifest) {
    log.section('上次部署');
    console.log(`  ${manifest.updatedAt}`);
    console.log(`  Paper ${manifest.paper ? `构建 ${manifest.paper.build}` : '未记录'} · MCP ${manifest.mcp ? manifest.mcp.file : '未记录'} · Agent ${manifest.backend || '未启用'}`);
  }
  if (state.problems.length > 0) {
    log.section('需要注意');
    for (const problem of state.problems) log.warn(problem);
    return 1;
  }
  return 0;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log.fail(error.message);
    if (error.hint) log.step(error.hint);
    process.exitCode = 2;
    return;
  }
  if (options.command === 'help') {
    printHelp();
    return;
  }
  if (options.command === 'version') {
    console.log(require('../package.json').version);
    return;
  }
  log.title(`buildervillager · Paper ${options.minecraft}`);
  log.step(`服务目录 ${options.directory}`);
  if (options.command === 'skills') options.components = ['skills'];
  if (options.components.length === 0) {
    // 只有真正的终端才弹菜单；管道 / CI 下按「全选减去 --skip」执行，避免卡住等输入。
    const canPrompt = options.interactive && process.stdin.isTTY && process.stdout.isTTY;
    if (!canPrompt) {
      options.components = COMPONENTS.map((component) => component.key).filter((key) => !options.skip.has(key));
    } else {
      try {
        options.components = await resolveComponents(options);
      } catch (error) {
        log.fail(error.message);
        if (error.hint) log.step(error.hint);
        process.exitCode = 1;
        return;
      }
      log.step(`已选：${options.components.map((key) => COMPONENTS.find((component) => component.key === key).label).join('、')}`);
    }
  }
  let state;
  try {
    state = await plan(options);
  } catch (error) {
    log.fail(error.message);
    if (error.hint) log.step(error.hint);
    process.exitCode = 1;
    return;
  }
  if (options.command === 'status' || options.command === 'check' || options.check) {
    printPlan(state, options);
    if (state.problems.length > 0) {
      log.section('需要注意');
      for (const problem of state.problems) log.warn(problem);
      process.exitCode = 1;
      return;
    }
    log.section('仅检查模式');
    log.ok('未做任何改动，去掉 --check 即执行');
    return;
  }
  printPlan(state, options);
  if (options.command === 'doctor') {
    await doctor(state, options);
    return;
  }
  if (state.problems.length > 0) {
    log.section('需要注意');
    for (const problem of state.problems) log.warn(problem);
    log.fail('存在阻塞问题，未做改动');
    process.exitCode = 1;
    return;
  }
  log.section('执行');
  try {
    await apply(state, options);
  } catch (error) {
    log.fail(error.message);
    if (error.hint) log.step(error.hint);
    process.exitCode = 1;
    return;
  }
  printNextSteps(state, options);
}

/** 部署后自检：Java、文件齐全、配置一致、端口占用、CLI 可执行、技能到位。 */
async function doctor(state, options) {
  const target = state.target;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('Java 25', state.major >= 25, state.java || '未找到');
  const paper = findPaper(target.directory, options.minecraft);
  add(`Paper ${options.minecraft}`, Boolean(paper), paper ? path.basename(paper) : '未安装');
  add('WorldEdit', Boolean(findPlugin(target.directory, 'worldedit')), findPlugin(target.directory, 'worldedit') || '未安装');
  add('WorldGuard', Boolean(findPlugin(target.directory, 'worldguard')), findPlugin(target.directory, 'worldguard') || '未安装');
  add('BuilderVillager 插件', Boolean(findPlugin(target.directory, 'buildervillager-paper')), findPlugin(target.directory, 'buildervillager-paper') || '未安装');
  const mcpJar = fs.existsSync(target.mcp)
    ? listJars(target.mcp, '^buildervillager-mcp.*\\.jar$')[0]
    : '';
  add('MCP 服务程序', Boolean(mcpJar), mcpJar || '未部署');
  const secretPath = path.join(target.mcp, SECRET_FILE);
  const secret = fs.existsSync(secretPath) ? fs.readFileSync(secretPath, 'utf8').trim() : '';
  add('共享密钥', validSecret(secret), secret ? `${secret.length} 字符` : '缺失');
  const serviceConfig = readJson(path.join(target.mcp, 'mcp.json'), null);
  add('MCP 配置', Boolean(serviceConfig), serviceConfig ? `端口 ${serviceConfig.port}` : '缺失');
  const paperConfig = readJson(target.paperConfig, null);
  add('Paper 侧配置', Boolean(paperConfig) && paperConfig.bridgeSecret === secret, paperConfig ? '密钥一致' : '缺失');
  add('EULA', eulaAccepted(target.eula), eulaAccepted(target.eula) ? '已接受' : '未接受');
  if (state.backend) {
    add(`Agent CLI (${state.backend})`, Boolean(state.executable), state.executable || '未找到');
  } else {
    add('Agent CLI', false, '未探测到 codex 或 dsh');
  }
  if (state.skillTarget) {
    for (const name of ['buildervillager-construction', 'buildervillager-knowledge-curation']) {
      const file = path.join(state.skillTarget, name, 'SKILL.md');
      add(`技能 ${name}`, fs.existsSync(file), fs.existsSync(file) ? file : '缺失');
    }
  }
  log.section('自检');
  for (const check of checks) {
    const mark = check.ok ? color.green('✓') : color.red('✗');
    console.log(`  ${mark} ${check.name.padEnd(20)} ${color.dim(check.detail)}`);
  }
  const failed = checks.filter((check) => !check.ok);
  log.section(failed.length === 0 ? '全部通过' : `${failed.length} 项未通过`);
  if (failed.length > 0) process.exitCode = 1;
}

function printHelp() {
  console.log(`buildervillager — 一项或多项组件的检查 / 部署 / 更新

用法
  buildervillager [命令] [选项]
  默认自动安装全部组件；--interactive 可进入组件多选菜单

命令
  install   检查 → 部署 → 更新（默认）
  update    同 install；升级后重跑即可
  check     只检查差异，不改动
  status    同 check，并显示上次部署记录
  skills    只安装 Agent 技能

组件（可多选）
  paper     Paper 26.3 服务端
  plugins   WorldEdit + WorldGuard
  mcp       MCP 服务（程序 + 配置 + 共享密钥 + 启动脚本）
  skills    Agent 技能（安装到 CLI 自己的技能目录）

选项
  -d, --dir <目录>         服务目录，默认 ./buildervillager-server
  -m, --minecraft <版本>   Paper 版本，默认 26.3
      --only <组件,...>    只处理这些组件，如 --only paper,mcp
      --skip <组件,...>    跳过这些组件
      --skip-paper --skip-plugins --skip-mcp --skip-skills
      --backend <后端>     codex 或 deepseek，默认按 PATH 探测
      --executable <路径>  指定 CLI 完整路径
      --java-home <路径>   JDK 25 目录，默认探测已有 Java，缺少时自动安装
      --port <端口>        公开 MCP 端口，默认 25576
      --bridge-port <端口> Paper 内部端口，默认 25577
      --concurrency <1-4>  Agent 并行数，默认 2
      --timeout <秒>       单次 Agent 超时，默认 1200
      --eula               写入 eula=true（表示你同意 Mojang EULA）
      --force              覆盖已有配置并重新下载
      --rotate-secret      重新生成共享密钥
      --print-secret       输出共享密钥
      --no-interactive     不显示菜单，按默认全选执行（适合脚本）
      --interactive        显示组件选择菜单
      --check, --dry-run   只检查
  -h, --help               显示帮助
  -v, --version            显示版本

示例
  npx --yes @rzdfzcl/buildervillager@latest          # 下载后立即运行部署工具
  npm install -g @rzdfzcl/buildervillager           # 仅安装工具，之后执行下一行
  buildervillager                                  # 菜单里勾选要装的组件
  buildervillager --only paper,mcp -d D:\\mc\\server --eula
  buildervillager check                            # 看看哪些组件有更新
  buildervillager update --skip-paper              # 只更新插件、MCP 与技能
  buildervillager skills --backend codex           # 只装技能`);
}

module.exports = { main, parseArgs, plan, apply, status, DEFAULTS };
