'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

test('独立安装脚本在 npm 不可用时从 GitHub 下载并校验后自动安装', { skip:process.platform !== 'win32' }, (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bv-github-installer-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const source=path.join(root,'source');const target=path.join(root,'target');
  fs.mkdirSync(path.join(source,'package/bin'),{recursive:true});fs.mkdirSync(target);
  fs.writeFileSync(path.join(source,'package/bin/buildervillager.js'),"require('node:fs').writeFileSync(process.env.BV_TEST_RESULT,JSON.stringify(process.argv.slice(2)))");
  const archive=path.join(root,'fixture.tgz');
  const tar=path.join(process.env.SystemRoot,'System32/tar.exe');
  assert.equal(spawnSync(tar,['-czf',archive,'-C',source,'package'],{windowsHide:true}).status,0);
  const hash=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const version=require('../package.json').version;
  const installer=path.join(target,'install.cmd');fs.copyFileSync(path.join(__dirname,'../install.cmd'),installer);
  const escape=(value)=>value.replaceAll("'","''");
  const script=String.raw`
$ErrorActionPreference='Stop'
$env:BV_INSTALL_SELF='${escape(installer)}'
$env:BV_TEST_RESULT='${escape(path.join(root,'result.json'))}'
function Invoke-RestMethod { param($Uri,$TimeoutSec); throw 'npm unavailable in test' }
function Invoke-WebRequest { param([switch]$UseBasicParsing,$Uri,$OutFile)
 if ([string]$Uri -like '*/SHA256SUMS.txt') { return @{Content='${hash}  rzdfzcl-buildervillager-${version}.tgz'} }
 if ([string]$Uri -notlike 'https://github.com/rzdfzcl/buildervillager/releases/download/v${version}/*.tgz') { throw 'Unexpected download source' }
 Copy-Item -LiteralPath '${escape(archive)}' -Destination $OutFile
}
$lines=Get-Content -LiteralPath $env:BV_INSTALL_SELF
$i=[Array]::IndexOf($lines,'# POWERSHELL-BEGIN')
& ([scriptblock]::Create(($lines[($i+1)..($lines.Length-1)] -join [Environment]::NewLine)))
`;
  const scriptFile=path.join(root,'test.ps1');fs.writeFileSync(scriptFile,'\ufeff'+script);
  const result=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',scriptFile],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'result.json'),'utf8')),['--dir',path.join(target,'buildervillager-server'),'--no-interactive']);
});
