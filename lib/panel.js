'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('./util');
const { spawnSync } = require('node:child_process');

function installPanel(directory) {
  const target = path.join(directory, 'panel');
  fs.mkdirSync(target, { recursive: true });
  for (const file of ['core.ps1', 'panel.ps1', 'stop.ps1', 'panel.xaml', 'host.cs', 'build-host.ps1']) {
    let content = fs.readFileSync(path.join(__dirname, '..', 'panel', file), 'utf8').replace(/^\ufeff/, '');
    if (file.endsWith('.ps1')) content = '\ufeff' + content;
    writeAtomic(path.join(target, file), content);
  }
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(target, 'build-host.ps1'), '-Directory', target], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`管理面板启动器生成失败：${result.stderr || result.error?.message}`);
  }
  writeAtomic(path.join(directory, 'panel.cmd'), [
    '@echo off', 'chcp 65001 >nul', 'setlocal',
    'start "BuilderVillager" "%~dp0panel\\BuilderVillager.Panel.exe" "%~dp0."', '',
  ].join('\r\n'));
}

module.exports = { installPanel };
