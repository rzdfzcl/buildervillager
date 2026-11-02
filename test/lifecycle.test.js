'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const{spawnSync}=require('node:child_process');
test('服务重启与切世界会等待退出，非法输入不停止服务，超时不强制结束', {skip:process.platform!=='win32'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bv-lifecycle-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const escape=v=>v.replaceAll("'","''");
 const script=String.raw`
$ErrorActionPreference='Stop'
. ([scriptblock]::Create([IO.File]::ReadAllText('${escape(path.join(__dirname,'../panel/core.ps1'))}',[Text.Encoding]::UTF8)))
$ast=[Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText('${escape(path.join(__dirname,'../panel/panel.ps1'))}',[Text.Encoding]::UTF8),[ref]$null,[ref]$null)
foreach($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Queue-Restart','Continue-ServiceOperations')},$true)){. ([scriptblock]::Create($definition.Extent.Text))}
$script:Root=$PSScriptRoot;$script:Dirty=$false;$script:RestartRequests=@{};$script:StopJobs=@{};$script:Starting=@{};$script:Calls=@()
$script:Known=@{paper=@([pscustomobject]@{ProcessId=100});mcp=@([pscustomobject]@{ProcessId=200})}
function Get-PanelProcesses {param($Root);return $script:Known}
function Ensure-Eula {return $true}
function Notice {param($Text,$ErrorState)}
function Load-Configuration {}
function Stop-PanelService {param($Kind);$script:Calls+='stop:'+ $Kind}
function Start-PanelService {param($Relative,$Eula);$script:Calls+='start:'+ $Relative}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'server.properties'),(@('level-name=world','white-list=false','') -join [Environment]::NewLine))
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'other') | Out-Null
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'other/level.dat'),'fixture')
Queue-Restart 'paper' 'other'
if($script:Calls -join ',' -ne 'stop:paper' -or $script:RestartRequests.Count -ne 1){throw 'Restart did not wait for shutdown'}
if(!(Read-PanelText (Join-Path $PSScriptRoot 'server.properties')).Contains('level-name=world')){throw 'World changed while running'}
$script:Known.paper=@();Continue-ServiceOperations $script:Known
if((Read-ServerProperties $PSScriptRoot)['level-name'] -ne 'other' -or $script:Calls[-1] -ne 'start:start-paper.cmd'){throw 'World was not switched before restart'}
$script:Calls=@();Queue-Restart 'paper' '../escape'
if($script:Calls.Count -ne 0 -or $script:RestartRequests.Count -ne 0){throw 'Invalid world stopped a service'}
Queue-Restart 'mcp'
if($script:Calls[-1] -ne 'stop:mcp'){throw 'MCP restart missing stop'}
$script:Known.mcp=@();Continue-ServiceOperations $script:Known
if($script:Calls[-1] -ne 'start:mcp/start.cmd'){throw 'MCP was not restarted'}
$script:Known.paper=@([pscustomobject]@{ProcessId=300});$script:Calls=@();Queue-Restart 'paper'
$script:RestartRequests.paper.Started=(Get-Date).AddMinutes(-3)
Continue-ServiceOperations $script:Known
if($script:RestartRequests.Count -ne 0 -or $script:Calls.Count -ne 1){throw 'Timed out operation forced a restart'}
Write-Output 'LIFECYCLE_OK'
`;
 const file=path.join(root,'test.ps1');fs.writeFileSync(file,'\ufeff'+script);
 const result=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',file],{encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/LIFECYCLE_OK/);
});
