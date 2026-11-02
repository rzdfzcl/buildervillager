'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CliError, readJson, hashFileSync, download } = require('./util');

const VENDOR = path.join(__dirname, '..', 'vendor');

function bundledArtifact(key, minecraft, platform = process.platform, arch = process.arch) {
  const manifest = readJson(path.join(VENDOR, 'manifest.json'));
  const artifact = manifest && manifest.artifacts && manifest.artifacts[key];
  if (!artifact) return null;
  if (artifact.minecraft && artifact.minecraft !== minecraft) return null;
  if (artifact.platform && (artifact.platform !== platform || artifact.arch !== arch)) return null;
  const source = path.resolve(VENDOR, artifact.file);
  if (!source.startsWith(VENDOR + path.sep)) throw new CliError('安装包资源路径无效');
  return { ...artifact, source };
}

async function materialize(artifact, destination) {
  if (!artifact.checksum) throw new CliError(`资源缺少校验值：${artifact.name}`);
  if (await hashFileSync(destination, artifact.algorithm) === artifact.checksum) return;
  if (artifact.source) {
    if (await hashFileSync(artifact.source, artifact.algorithm) !== artifact.checksum) {
      throw new CliError(`安装包资源校验失败：${artifact.name}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(artifact.source, destination);
  } else {
    await download(artifact.url, destination, { algorithm: artifact.algorithm, expected: artifact.checksum });
  }
}

module.exports = { VENDOR, bundledArtifact, materialize };
