'use strict';
/**
 * 把 MCP 服务程序与技能模板复制到 vendor/，让 npm 包自带可运行的服务端。
 *
 * 两种运行环境都要支持：
 *   1. 仓库内（有 mcp/build/libs 与 src/main/resources）—— 从构建产物复制；
 *   2. 独立发布仓库（只有 vendor/）      —— 已提交的 vendor 内容原样保留。
 *
 * npm 发布前由 prepack 自动执行。
 */
const fs = require('node:fs');
const path = require('node:path');

const npmRoot = path.join(__dirname, '..');
const vendor = path.join(npmRoot, 'vendor');
const monorepoRoot = path.join(npmRoot, '..');

function readVersion() {
  const candidates = [
    path.join(monorepoRoot, 'gradle.properties'),
    path.join(npmRoot, 'package.json'),
  ];
  const gradle = candidates[0];
  if (fs.existsSync(gradle)) {
    const line = fs.readFileSync(gradle, 'utf8').split(/\r?\n/).find((item) => item.startsWith('mod_version='));
    if (line) return line.split('=')[1].trim();
  }
  return JSON.parse(fs.readFileSync(candidates[1], 'utf8')).version;
}

function findJar(version) {
  const directory = path.join(monorepoRoot, 'mcp', 'build', 'libs');
  if (!fs.existsSync(directory)) return '';
  const exact = path.join(directory, `buildervillager-mcp-${version}.jar`);
  if (fs.existsSync(exact)) return exact;
  const match = fs.readdirSync(directory)
    .filter((name) => /^buildervillager-mcp-.*\.jar$/.test(name))
    .sort((a, b) => fs.statSync(path.join(directory, b)).mtimeMs - fs.statSync(path.join(directory, a)).mtimeMs)[0];
  return match ? path.join(directory, match) : '';
}

function copySkills() {
  const source = path.join(monorepoRoot, 'src', 'main', 'resources', 'assets', 'buildervillager', 'skills');
  if (!fs.existsSync(source)) return 0;
  const target = path.join(vendor, 'skills');
  fs.mkdirSync(target, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(source, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    fs.mkdirSync(path.join(target, entry.name), { recursive: true });
    fs.copyFileSync(file, path.join(target, entry.name, 'SKILL.md'));
    count += 1;
  }
  return count;
}

function main() {
  const version = readVersion();
  const jar = findJar(version);
  fs.mkdirSync(vendor, { recursive: true });

  if (jar) {
    fs.copyFileSync(jar, path.join(vendor, 'buildervillager-mcp.jar'));
    console.log(`  buildervillager-mcp.jar ← ${path.relative(monorepoRoot, jar)}`);
  } else if (fs.existsSync(path.join(vendor, 'buildervillager-mcp.jar'))) {
    console.log('  buildervillager-mcp.jar 已存在，保留（独立发布仓库模式）');
  } else {
    console.error('未找到 MCP 服务程序：在仓库内先运行 gradlew :mcp:jar，或确认 vendor/buildervillager-mcp.jar 已提交');
    process.exitCode = 1;
    return;
  }

  const skills = copySkills();
  if (skills > 0) {
    console.log(`  skills/ 已同步 ${skills} 个技能`);
  } else {
    const existing = fs.existsSync(path.join(vendor, 'skills'))
      ? fs.readdirSync(path.join(vendor, 'skills')).length
      : 0;
    console.log(`  skills/ 已存在 ${existing} 个技能，保留（独立发布仓库模式）`);
  }

  const skillDirs = fs.existsSync(path.join(vendor, 'skills'))
    ? fs.readdirSync(path.join(vendor, 'skills')).filter((name) => fs.existsSync(path.join(vendor, 'skills', name, 'SKILL.md')))
    : [];
  console.log(`vendor 就绪：1 个服务程序，${skillDirs.length} 个技能`);
}

main();
