param([Parameter(Mandatory=$true)][string]$ServerDirectory,[ValidateSet('paper','mcp')][string]$Kind)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'core.ps1')
try {
  $processes = Get-PanelProcesses $ServerDirectory
  $targets = @($processes[$Kind])
  if ($targets.Count -ne 1) { throw 'Cannot identify exactly one service process.' }
  $target = $targets[0]
  $allowedParent = 0
  $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $target.ParentProcessId) -ErrorAction SilentlyContinue
  if ($parent -and $parent.Name -eq 'cmd.exe' -and $parent.CommandLine.IndexOf($ServerDirectory,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $allowedParent=[int]$parent.ProcessId }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class PanelConsoleSignal {
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AttachConsole(uint processId);
 [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList(uint[] list,uint count);
 [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler,bool add);
 [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint signal,uint group);
 public static void Stop(uint target,uint parent) {
  FreeConsole();
  if (!AttachConsole(target)) throw new Exception("No dedicated service console is available. Use stop in the original server console.");
  try {
   uint[] ids=new uint[256]; uint count=GetConsoleProcessList(ids,(uint)ids.Length);
   if(count==0 || count>ids.Length) throw new Exception("Cannot verify service console ownership.");
   uint self=(uint)System.Diagnostics.Process.GetCurrentProcess().Id;
   for(int i=0;i<count;i++) if(ids[i]!=target && ids[i]!=self && ids[i]!=parent) throw new Exception("This console contains other processes. Use the original console to stop this service.");
   SetConsoleCtrlHandler(IntPtr.Zero,true);
   if(!GenerateConsoleCtrlEvent(0,0)) throw new Exception("Cannot deliver shutdown signal.");
   Thread.Sleep(250);
  } finally { FreeConsole(); }
 }
}
'@
  [PanelConsoleSignal]::Stop([uint32]$target.ProcessId,[uint32]$allowedParent)
  exit 0
} catch {
  [IO.File]::WriteAllText((Join-Path $ServerDirectory ('panel-stop-' + $Kind + '.error.txt')),$_.Exception.Message)
  exit 1
}
