'use strict';
const path = require('node:path');
const { writeAtomic } = require('./util');

function writeUnifiedLauncher(directory) {
  writeAtomic(path.join(directory, 'start.cmd'), [
    '@echo off', 'chcp 65001 >nul', 'setlocal',
    '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"',
    'if not errorlevel 1 exit /b 0', 'echo 启动失败，请查看上面的错误。', 'pause', 'exit /b 1', '',
  ].join('\r\n'));
  // Windows PowerShell 5.1 requires a BOM to read Chinese paths and prompts reliably.
  writeAtomic(path.join(directory, 'start.ps1'), '\ufeff' + [
    'param([switch]$CheckOnly)',
    "$ErrorActionPreference = 'Stop'",
    'Set-Location -LiteralPath $PSScriptRoot',
    'try {',
    "  foreach ($file in @('start-paper.cmd', 'mcp/start.cmd', 'mcp/mcp.json', 'eula.txt')) {",
    "    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $file))) { throw ('缺少文件：' + $file + '，请重新运行安装脚本。') }",
    '  }',
    "  $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'mcp/mcp.json') -Raw -Encoding UTF8 | ConvertFrom-Json",
    "  if ($CheckOnly) { Write-Host '统一启动入口检查通过'; exit 0 }",
    "  $eulaFile = Join-Path $PSScriptRoot 'eula.txt'",
    String.raw`  if ((Get-Content -LiteralPath $eulaFile -Raw) -notmatch '(?im)^\s*eula\s*=\s*true\s*$') {`,
    "    Write-Host 'Minecraft EULA：https://aka.ms/MinecraftEULA'",
    "    $answer = Read-Host '同意该协议并启动服务器？输入 Y 同意，其他输入退出'",
    "    if ($answer -notmatch '^(?i)y$') { Write-Host '未启动服务器。'; exit 0 }",
    "    Set-Content -LiteralPath $eulaFile -Value 'eula=true' -Encoding ASCII",
    '  }',
    '  function Listening([int]$Port) {',
    '    $client = New-Object Net.Sockets.TcpClient',
    "    try { $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null); if (!$pending.AsyncWaitHandle.WaitOne(300)) { return $false }; $client.EndConnect($pending); return $true }",
    '    catch { return $false } finally { $client.Dispose() }',
    '  }',
    '  function Start-ServiceWindow([string]$Script, [int]$Port, [string]$Label) {',
    "    if (Listening $Port) { Write-Host ($Label + ' 已在运行，端口 ' + $Port); return }",
    "    $scriptFile = Join-Path $PSScriptRoot $Script",
    `    $arguments = '/d /s /k ""' + $scriptFile + '""'`,
    '    Start-Process -FilePath $env:ComSpec -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null',
    "    Write-Host ($Label + ' 已在后台启动，日志可在管理面板查看。')",
    '  }',
    '  $paperPort = 25565',
    "  $properties = Join-Path $PSScriptRoot 'server.properties'",
    String.raw`  if (Test-Path -LiteralPath $properties) { $text = Get-Content -LiteralPath $properties -Raw; if ($text -match '(?im)^\s*server-port\s*=\s*(\d+)\s*$') { $paperPort = [int]$Matches[1] } }`,
    "  Start-ServiceWindow 'start-paper.cmd' $paperPort 'Paper'",
    "  Start-ServiceWindow 'mcp/start.cmd' ([int]$config.port) 'MCP'",
    "  Write-Host 'Paper 和 MCP 已在后台启动，请在管理面板查看状态与日志。'",
    '} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }', '',
  ].join('\r\n'));
}

module.exports = { writeUnifiedLauncher };
