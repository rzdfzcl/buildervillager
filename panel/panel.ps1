param([Parameter(Mandatory=$true)][string]$ServerDirectory,[switch]$CheckOnly)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework
. (Join-Path $PSScriptRoot 'core.ps1')
$script:Root=[IO.Path]::GetFullPath($ServerDirectory).TrimEnd('\','/')
$script:Dirty=$false; $script:Loading=$false; $script:LogKind='paper'; $script:StopJobs=@{}
try {
  $xaml=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'panel.xaml') -Raw -Encoding UTF8
  $reader=New-Object Xml.XmlNodeReader ([xml]$xaml)
  $script:Window=[Windows.Markup.XamlReader]::Load($reader)
  $script:Controls=@{}
  foreach ($match in [regex]::Matches($xaml,'x:Name="([^"]+)"')) { $name=$match.Groups[1].Value; $script:Controls[$name]=$script:Window.FindName($name) }
  $script:Controls.ServerPath.Text=$script:Root
  function Notice([string]$Text,[bool]$ErrorState=$false) {
    $script:Controls.Notice.Text=$Text
    $script:Controls.Notice.Foreground=if ($ErrorState) { '#FFB0A5' } else { '#A3B4C9' }
  }
  function Select-Value([string]$Name,[string]$Value) {
    foreach ($item in $script:Controls[$Name].Items) { if ([string]$item.Tag -eq $Value) { $script:Controls[$Name].SelectedItem=$item; return } }
    $script:Controls[$Name].SelectedIndex=0
  }
  function Load-Configuration {
    $script:Loading=$true
    try {
      $script:Configuration=Get-PanelConfiguration $script:Root
      $p=$script:Configuration.properties; $m=$script:Configuration.mcp
      foreach ($pair in @(@('Motd','motd'),@('PaperPort','server-port'),@('MaxPlayers','max-players'),@('ViewDistance','view-distance'),@('SimulationDistance','simulation-distance'))) { $script:Controls[$pair[0]].Text=$p[$pair[1]] }
      foreach ($pair in @(@('OnlineMode','online-mode'),@('Whitelist','white-list'),@('Pvp','pvp'),@('AllowFlight','allow-flight'))) { $script:Controls[$pair[0]].IsChecked=$p[$pair[1]] -eq 'true' }
      Select-Value 'Difficulty' $p.difficulty; Select-Value 'Gamemode' $p.gamemode
      $script:Controls.MinMemory.Text=[string]$script:Configuration.minMemoryGb
      $script:Controls.MaxMemory.Text=[string]$script:Configuration.maxMemoryGb
      $script:Controls.McpPort.Text=[string]$m.port
      $bridgePort=25577; if ($m.bridgeUrl) { $bridgePort=([uri]$m.bridgeUrl).Port }
      $script:Controls.BridgePort.Text=[string]$bridgePort
      $script:Controls.AgentEnabled.IsChecked=[bool]$m.agent.enabled
      Select-Value 'Backend' $m.agent.backend
      $script:Controls.Executable.Text=[string]$m.agent.executable
      $script:Controls.Concurrency.Text=[string]$m.agent.concurrency
      $script:Controls.Timeout.Text=[string]$m.agent.timeoutSeconds
      $script:Dirty=$false; Notice '配置已载入；保存前会自动创建备份。'
    } finally { $script:Loading=$false }
  }
  function Show-Log {
    $file=Join-Path $script:Root 'logs/latest.log'
    if ($script:LogKind -eq 'mcp') {
      $file=Join-Path $script:Root 'mcp/logs/latest.log'
      $agent=Get-ChildItem -LiteralPath (Join-Path $script:Root 'mcp/agent-state') -Filter '*.log' -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($agent) { $file=$agent.FullName }
    }
    if (Test-Path -LiteralPath $file) { $script:Controls.LogText.Text=((Read-PanelText $file) -split '\r?\n' | Select-Object -Last 180) -join "`r`n" }
    else { $script:Controls.LogText.Text='暂无日志。服务启动后可在这里查看。' }
    $script:Controls.LogText.ScrollToEnd()
  }
  function Refresh-Status {
    try {
      $processes=Get-PanelProcesses $script:Root
      $disk=$script:Configuration
      foreach ($kind in @('paper','mcp')) {
        $prefix=if ($kind -eq 'paper') { 'Paper' } else { 'Mcp' }
        $port=if ($kind -eq 'paper') { [int]$disk.properties['server-port'] } else { [int]$disk.mcp.port }
        $running=@($processes[$kind]); $listening=Test-PanelPort $port
        $state='已停止'; $color='#8395AD'; $metric='未运行'; $detail='端口 ' + $port
        if ($running.Count -gt 0) {
          $state=if ($listening) { '运行中' } else { '启动 / 关闭中' }; $color='#6FE3B7'
          $memory=($running | Measure-Object WorkingSetSize -Sum).Sum / 1MB
          $metric=('{0:N0} MB' -f $memory)
          $elapsed=(Get-Date)-[datetime]$running[0].CreationDate
          $detail=('PID ' + $running[0].ProcessId + '  ·  端口 ' + $port + '  ·  运行 ' + [math]::Floor($elapsed.TotalMinutes) + ' 分钟')
        } elseif ($listening) { $state='端口被占用'; $color='#F4C883'; $metric='端口 ' + $port; $detail='监听程序未匹配到本服务目录' }
        $script:Controls[$prefix+'State'].Text=$state; $script:Controls[$prefix+'State'].Foreground=$color
        $script:Controls[$prefix+'Metric'].Text=$metric; $script:Controls[$prefix+'Detail'].Text=$detail
        $script:Controls['Start'+$prefix].IsEnabled=(!$listening -and $running.Count -eq 0)
        $script:Controls['Stop'+$prefix].IsEnabled=($running.Count -eq 1)
      }
      foreach ($kind in @($script:StopJobs.Keys)) {
        if ($script:StopJobs[$kind].HasExited) {
          if ($script:StopJobs[$kind].ExitCode -ne 0) {
            $errorFile=Join-Path $script:Root ('panel-stop-'+$kind+'.error.txt')
            $message='无法正常停止，请在原控制台输入 stop。'; if (Test-Path -LiteralPath $errorFile) { $message=Get-Content -LiteralPath $errorFile -Raw }
            Notice $message $true
          } else { Notice '已发送正常关闭信号，正在等待服务退出。' }
          $script:StopJobs.Remove($kind)
        }
      }
      $script:Controls.UpdatedAt.Text='状态每 3 秒刷新  ·  最后检查 '+(Get-Date -Format 'HH:mm:ss')
    } catch { Notice ('状态读取失败：'+$_.Exception.Message) $true }
  }
  function Ensure-Eula {
    $file=Join-Path $script:Root 'eula.txt'
    if ((Get-Content -LiteralPath $file -Raw) -match '(?im)^\s*eula\s*=\s*true\s*$') { return $true }
    $choice=[Windows.MessageBox]::Show($script:Window,"启动 Minecraft 服务端需要同意 EULA：`nhttps://aka.ms/MinecraftEULA`n`n是否同意并启动？",'Minecraft EULA','YesNo','Question')
    if ($choice -ne 'Yes') { return $false }
    Write-PanelAtomic $file "eula=true`r`n"; return $true
  }
  function Start-PanelService([string]$Relative,[bool]$NeedsEula) {
    try {
      if ($NeedsEula -and !(Ensure-Eula)) { return }
      $file=Join-Path $script:Root $Relative
      $arguments='/d /s /k ""'+$file+'""'
      Start-Process -FilePath $env:ComSpec -ArgumentList $arguments -WorkingDirectory $script:Root -WindowStyle Hidden | Out-Null
      Notice '启动请求已提交，服务状态会自动更新。'; Refresh-Status
    } catch { Notice $_.Exception.Message $true }
  }
  function Stop-PanelService([string]$Kind) {
    if ($script:StopJobs.ContainsKey($Kind)) { return }
    $helper=Join-Path $PSScriptRoot 'stop.ps1'
    $powershell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$helper+'" -ServerDirectory "'+$script:Root+'" -Kind '+$Kind
    $script:StopJobs[$Kind]=Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Notice '正在请求服务正常关闭…'
  }
  Load-Configuration
  $script:Controls.Save.Add_Click({
    try {
      $c=$script:Controls
      $values=[pscustomobject]@{motd=$c.Motd.Text;paperPort=$c.PaperPort.Text;maxPlayers=$c.MaxPlayers.Text;difficulty=[string]$c.Difficulty.SelectedItem.Tag;gamemode=[string]$c.Gamemode.SelectedItem.Tag;viewDistance=$c.ViewDistance.Text;simulationDistance=$c.SimulationDistance.Text;onlineMode=[bool]$c.OnlineMode.IsChecked;whitelist=[bool]$c.Whitelist.IsChecked;pvp=[bool]$c.Pvp.IsChecked;allowFlight=[bool]$c.AllowFlight.IsChecked;minMemoryGb=$c.MinMemory.Text;maxMemoryGb=$c.MaxMemory.Text;mcpPort=$c.McpPort.Text;bridgePort=$c.BridgePort.Text;backend=[string]$c.Backend.SelectedItem.Tag;executable=$c.Executable.Text;concurrency=$c.Concurrency.Text;timeoutSeconds=$c.Timeout.Text;agentEnabled=[bool]$c.AgentEnabled.IsChecked}
      $backup=Save-PanelConfiguration $script:Root $values $script:Configuration.revision
      Load-Configuration; Notice '已保存并备份。请重启相应服务使配置生效。'
    } catch { Notice $_.Exception.Message $true }
  })
  $script:Controls.Reload.Add_Click({
    if ($script:Dirty -and [Windows.MessageBox]::Show($script:Window,'放弃尚未保存的修改并重新载入？','重新载入','YesNo','Question') -ne 'Yes') { return }
    try { Load-Configuration } catch { Notice $_.Exception.Message $true }
  })
  foreach ($control in $script:Controls.Values) {
    $changed={ if (!$script:Loading) { $script:Dirty=$true; Notice '有未保存的修改。' } }
    if ($control -is [Windows.Controls.TextBox] -and !$control.IsReadOnly) { $control.Add_TextChanged($changed) }
    if ($control -is [Windows.Controls.ComboBox]) { $control.Add_SelectionChanged($changed) }
    if ($control -is [Windows.Controls.CheckBox]) { $control.Add_Checked($changed); $control.Add_Unchecked($changed) }
  }
  $script:Controls.StartAll.Add_Click({ Start-PanelService 'start.cmd' $true })
  $script:Controls.StartPaper.Add_Click({ Start-PanelService 'start-paper.cmd' $true })
  $script:Controls.StartMcp.Add_Click({ Start-PanelService 'mcp/start.cmd' $false })
  $script:Controls.StopPaper.Add_Click({ Stop-PanelService 'paper' })
  $script:Controls.StopMcp.Add_Click({ Stop-PanelService 'mcp' })
  $script:Controls.OpenFolder.Add_Click({ Start-Process explorer.exe -ArgumentList ('"'+$script:Root+'"') })
  $script:Controls.PaperLogs.Add_Click({ $script:LogKind='paper';$script:Controls.Tabs.SelectedIndex=2;Show-Log })
  $script:Controls.McpLogs.Add_Click({ $script:LogKind='mcp';$script:Controls.Tabs.SelectedIndex=2;Show-Log })
  $script:Controls.SelectPaperLog.Add_Click({ $script:LogKind='paper';Show-Log })
  $script:Controls.SelectMcpLog.Add_Click({ $script:LogKind='mcp';Show-Log })
  $script:Controls.RefreshLog.Add_Click({ Show-Log })
  $script:Window.Add_Closing({ param($sender,$eventArgs)
    if ($script:Dirty -and [Windows.MessageBox]::Show($script:Window,'有未保存的修改，仍要关闭面板？','关闭面板','YesNo','Question') -ne 'Yes') { $eventArgs.Cancel=$true }
  })
  Refresh-Status
  if ($CheckOnly) {
    if ($script:Controls.Notice.Text.StartsWith('状态读取失败')) { throw $script:Controls.Notice.Text }
    Write-Output ('PAPER_STATUS='+$script:Controls.PaperState.Text+'; MCP_STATUS='+$script:Controls.McpState.Text)
    Write-Output 'PANEL_CHECK_OK'; $script:Window.Close(); exit 0
  }
  $timer=New-Object Windows.Threading.DispatcherTimer
  $timer.Interval=[TimeSpan]::FromSeconds(3)
  $timer.Add_Tick({ Refresh-Status; if ($script:Controls.Tabs.SelectedIndex -eq 2) { Show-Log } })
  $timer.Start()
  [void]$script:Window.ShowDialog()
  $timer.Stop()
} catch {
  if ($CheckOnly) { Write-Error $_; exit 1 }
  [void][Windows.MessageBox]::Show($_.Exception.Message,'管理面板启动失败','OK','Error'); exit 1
}
