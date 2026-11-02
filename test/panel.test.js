'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('面板保存、备份、端口联动与外部修改冲突保护', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-panel-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const folder of ['mcp','plugins/BuilderVillager','runtime/java/test/bin']) fs.mkdirSync(path.join(directory, folder), { recursive: true });
  fs.writeFileSync(path.join(directory, 'runtime/java/test/bin/java.exe'), 'fixture');
  fs.writeFileSync(path.join(directory, 'paper-26.3-237.jar'), 'fixture');
  fs.writeFileSync(path.join(directory, 'server.properties'), '# preserve comment\r\nmotd=Old\r\nlevel-seed=keep-seed\r\nserver-port=25565\r\n');
  fs.writeFileSync(path.join(directory, 'mcp/mcp.json'), JSON.stringify({ port:25576, custom:{ keep:true }, agent:{ directory:'custom-state', backend:'deepseek' } }));
  for (const file of ['mcp/paper-mcp.json','plugins/BuilderVillager/mcp.json']) fs.writeFileSync(path.join(directory,file), '{"bridgeSecret":"preserve-secret","enabled":true}');
  const core = path.join(__dirname, '../panel/core.ps1').replaceAll("'", "''");
  const script = String.raw`
$ErrorActionPreference='Stop'
. ([scriptblock]::Create([IO.File]::ReadAllText('${core}',[Text.Encoding]::UTF8)))
$root=$PSScriptRoot
$old=Get-PanelConfiguration $root
$writer=[IO.FileStream]::new((Join-Path $root 'server.properties'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
try { $whileWriting=Get-PanelConfiguration $root; if ($whileWriting.properties['level-seed'] -ne 'keep-seed') { throw 'Cannot read config while server holds writable handle' } } finally { $writer.Dispose() }
$inputValues=[pscustomobject]@{paperPort=25590;mcpPort=25591;bridgePort=25592;maxPlayers=40;difficulty='hard';gamemode='creative';viewDistance=12;simulationDistance=8;minMemoryGb=1;maxMemoryGb=6;concurrency=3;timeoutSeconds=600;backend='deepseek';executable='C:\tools\dsh.cmd';motd='中文服务器';onlineMode=$true;whitelist=$true;pvp=$false;allowFlight=$true;agentEnabled=$true}
$backup=Save-PanelConfiguration $root $inputValues $old.revision
if (!(Test-Path -LiteralPath (Join-Path $backup 'server.properties'))) { throw 'Backup missing' }
$mcp=Read-PanelJson (Join-Path $root 'mcp/mcp.json')
if (!$mcp.custom.keep -or $mcp.agent.directory -ne 'custom-state') { throw 'Unknown JSON fields lost' }
foreach($relative in @('mcp/paper-mcp.json','plugins/BuilderVillager/mcp.json')) {
 $fragment=Read-PanelJson (Join-Path $root $relative)
 if ($fragment.port -ne 25591 -or $fragment.bridgePort -ne 25592 -or $fragment.bridgeSecret -ne 'preserve-secret') { throw 'Bridge configuration drift' }
}
$props=Get-Content -LiteralPath (Join-Path $root 'server.properties') -Raw
if (!$props.Contains('# preserve comment') -or !$props.Contains('level-seed=keep-seed') -or !$props.Contains('pvp=false')) { throw 'Properties damaged' }
if ((Get-PanelConfiguration $root).properties['motd'] -ne '中文服务器') { throw 'Unicode round trip failed' }
if (!(Get-Content -LiteralPath (Join-Path $root 'start-paper.cmd') -Raw).Contains('-Xms1G -Xmx6G')) { throw 'Memory launcher not updated' }
$staleRejected=$false
try { Save-PanelConfiguration $root $inputValues $old.revision } catch { $staleRejected=$true }
if (!$staleRejected) { throw 'Stale overwrite allowed' }
$revision=Get-PanelRevision $root
$inputValues.mcpPort=25590
$badRejected=$false
try { Save-PanelConfiguration $root $inputValues $revision } catch { $badRejected=$true }
if (!$badRejected -or (Get-PanelRevision $root) -ne $revision) { throw 'Invalid port configuration was written' }
New-Item -ItemType Directory -Path (Join-Path $root 'world'),(Join-Path $root '第二世界'),(Join-Path $root 'world_nether') | Out-Null
foreach($world in @('world','第二世界','world_nether')) { [IO.File]::WriteAllText((Join-Path $root ($world+'/level.dat')),'fixture') }
$worlds=Get-PanelWorlds $root
if (@($worlds.Worlds).Count -ne 2) { throw 'Dimension folders must not be treated as independent worlds' }
Set-PanelWorld $root '第二世界'
if ((Get-PanelWorlds $root).Current -ne '第二世界') { throw 'World switch did not round trip Unicode' }
foreach($bad in @('../escape','mcp','')) {
 $rejected=$false; try { Assert-PanelWorldSelection $root $bad $false '' } catch { $rejected=$true }
 if (!$rejected) { throw 'Unsafe world selection accepted' }
}
$before=Get-PanelRevision $root
function Get-PanelProcesses { param($Root); return @{paper=@([pscustomobject]@{ProcessId=1});mcp=@()} }
$runningRejected=$false;try{Set-PanelWorld $root 'world'}catch{$runningRejected=$true}
if (!$runningRejected -or (Get-PanelRevision $root) -ne $before) {throw 'World configuration changed before Paper stopped'}
Write-Output 'PANEL_SAVE_TEST_OK'
`;
  const file = path.join(directory, 'test.ps1'); fs.writeFileSync(file, '\ufeff'+script);
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-ExecutionPolicy','Bypass','-File',file], { encoding:'utf8', windowsHide:true, timeout:30000 });
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/PANEL_SAVE_TEST_OK/);
});
