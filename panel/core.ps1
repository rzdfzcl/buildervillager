function Read-PanelText([string]$Path) {
  for ($attempt=0; $attempt -lt 6; $attempt++) {
    $stream=$null; $reader=$null
    try {
      $stream=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
      $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$true)
      return $reader.ReadToEnd()
    } catch [IO.IOException] { if ($attempt -eq 5) { throw }; Start-Sleep -Milliseconds 50 }
    finally { if ($reader) { $reader.Dispose() } elseif ($stream) { $stream.Dispose() } }
  }
}
function Read-PanelJson([string]$Path) {
  if (Test-Path -LiteralPath $Path) { return ((Read-PanelText $Path) | ConvertFrom-Json) }
  return [pscustomobject]@{}
}
function Set-PanelProperty($Object, [string]$Name, $Value) {
  $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value -Force
}
function Get-PanelFiles([string]$Root) {
  return @('server.properties','mcp/mcp.json','mcp/paper-mcp.json','plugins/BuilderVillager/mcp.json','.panel-settings.json','start-paper.cmd')
}
function Get-PanelRevision([string]$Root) {
  $parts = foreach ($relative in (Get-PanelFiles $Root)) {
    $file = Join-Path $Root $relative
    if (Test-Path -LiteralPath $file) {
      $algorithm=[Security.Cryptography.SHA256]::Create()
      try { [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes((Read-PanelText $file)))) } finally { $algorithm.Dispose() }
    } else { '-' }
  }
  return ($parts -join ':')
}
function Read-ServerProperties([string]$Root) {
  $values = @{}
  $file = Join-Path $Root 'server.properties'
  if (Test-Path -LiteralPath $file) {
    foreach ($line in ((Read-PanelText $file) -split '\r?\n')) {
      if ($line -match '^\s*([^#!\s=]+)\s*=\s*(.*)$') { $values[$Matches[1]] = $Matches[2] }
    }
  }
  return $values
}
function Get-PanelConfiguration([string]$Root) {
  $properties = Read-ServerProperties $Root
  $defaults = @{'server-port'='25565';'max-players'='20';difficulty='easy';gamemode='survival';motd='BuilderVillager Paper server';'online-mode'='true';'white-list'='false';'view-distance'='10';'simulation-distance'='10';pvp='true';'allow-flight'='false'}
  foreach ($key in $defaults.Keys) { if (!$properties.ContainsKey($key)) { $properties[$key] = $defaults[$key] } }
  $properties['motd'] = [regex]::Replace($properties['motd'], '\\u([a-fA-F0-9]{4})', { param($match) [string][char][Convert]::ToInt32($match.Groups[1].Value,16) }).Replace('\\','\')
  $mcp = Read-PanelJson (Join-Path $Root 'mcp/mcp.json')
  $memory = Read-PanelJson (Join-Path $Root '.panel-settings.json')
  $minimum = 2; $maximum = 4
  if ($memory.minMemoryGb) { $minimum = [int]$memory.minMemoryGb }
  if ($memory.maxMemoryGb) { $maximum = [int]$memory.maxMemoryGb }
  return [pscustomobject]@{ properties=$properties; mcp=$mcp; minMemoryGb=$minimum; maxMemoryGb=$maximum; revision=(Get-PanelRevision $Root) }
}
function Assert-PanelInteger($Value, [int]$Minimum, [int]$Maximum, [string]$Label) {
  $number = 0
  if (![int]::TryParse([string]$Value,[ref]$number) -or $number -lt $Minimum -or $number -gt $Maximum) { throw "$Label must be $Minimum-$Maximum" }
  return $number
}
function Write-PanelAtomic([string]$Path,[string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $temporary = $Path + '.panel-' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temporary,$Text,[Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) } else { [IO.File]::Move($temporary,$Path) }
}
function Get-PanelJava([string]$Root) {
  $local = Join-Path $Root 'runtime/java'
  if (Test-Path -LiteralPath $local) {
    $file = Get-ChildItem -LiteralPath $local -Recurse -Filter java.exe -File | Where-Object { $_.Directory.Name -eq 'bin' } | Select-Object -First 1
    if ($file) { return $file.FullName }
  }
  if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/java.exe'))) { return (Join-Path $env:JAVA_HOME 'bin/java.exe') }
  $command = Get-Command java.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw 'Java was not found. Run the installer again.'
}
function Get-PanelJar([string]$Root,[string]$Kind) {
  $directory = $Root; $filter = 'paper-*.jar'
  if ($Kind -eq 'mcp') { $directory = Join-Path $Root 'mcp'; $filter='buildervillager-mcp*.jar' }
  return (Get-ChildItem -LiteralPath $directory -Filter $filter -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
}
function Save-PanelConfiguration([string]$Root,$InputValues,[string]$Revision) {
  if ((Get-PanelRevision $Root) -ne $Revision) { throw 'Configuration changed on disk. Reload before saving.' }
  $paperPort = Assert-PanelInteger $InputValues.paperPort 1 65535 'Paper port'
  $mcpPort = Assert-PanelInteger $InputValues.mcpPort 1 65535 'MCP port'
  $bridgePort = Assert-PanelInteger $InputValues.bridgePort 1 65535 'Bridge port'
  if (@($paperPort,$mcpPort,$bridgePort | Select-Object -Unique).Count -ne 3) { throw 'Paper, MCP and bridge ports must be different.' }
  $players = Assert-PanelInteger $InputValues.maxPlayers 1 10000 'Max players'
  $view = Assert-PanelInteger $InputValues.viewDistance 2 32 'View distance'
  $simulation = Assert-PanelInteger $InputValues.simulationDistance 2 32 'Simulation distance'
  $concurrency = Assert-PanelInteger $InputValues.concurrency 1 4 'Agent concurrency'
  $timeout = Assert-PanelInteger $InputValues.timeoutSeconds 10 86400 'Agent timeout'
  $minimum = Assert-PanelInteger $InputValues.minMemoryGb 1 128 'Minimum memory'
  $maximum = Assert-PanelInteger $InputValues.maxMemoryGb 1 128 'Maximum memory'
  if ($minimum -gt $maximum) { throw 'Minimum memory must not exceed maximum memory.' }
  if ($InputValues.difficulty -notin @('peaceful','easy','normal','hard')) { throw 'Invalid difficulty.' }
  if ($InputValues.gamemode -notin @('survival','creative','adventure','spectator')) { throw 'Invalid game mode.' }
  if ($InputValues.backend -notin @('deepseek','codex')) { throw 'Invalid Agent backend.' }
  foreach ($value in @($InputValues.motd,$InputValues.executable)) { if ([string]$value -match '[\r\n\x00]') { throw 'Configuration values cannot contain newlines.' } }
  $changes = @{'server-port'=[string]$paperPort;'max-players'=[string]$players;difficulty=[string]$InputValues.difficulty;gamemode=[string]$InputValues.gamemode;'view-distance'=[string]$view;'simulation-distance'=[string]$simulation}
  foreach ($pair in @(@('online-mode','onlineMode'),@('white-list','whitelist'),@('pvp','pvp'),@('allow-flight','allowFlight'))) { $changes[$pair[0]] = ([bool]$InputValues.($pair[1])).ToString().ToLowerInvariant() }
  $motd = New-Object Text.StringBuilder
  foreach ($character in ([string]$InputValues.motd).ToCharArray()) {
    if ([int]$character -gt 126) { [void]$motd.Append(('\u{0:x4}' -f [int]$character)) }
    elseif ($character -eq '\') { [void]$motd.Append('\\') } else { [void]$motd.Append($character) }
  }
  $changes['motd'] = $motd.ToString()
  $lines = @((Read-PanelText (Join-Path $Root 'server.properties')) -split '\r?\n')
  $seen = @{}
  $rewritten = foreach ($line in $lines) {
    if ($line -match '^\s*([^#!\s=]+)\s*=') {
      $key=$Matches[1]
      if ($changes.ContainsKey($key)) { if (!$seen.ContainsKey($key)) { "$key=$($changes[$key])"; $seen[$key]=$true }; continue }
    }
    $line
  }
  foreach ($key in $changes.Keys) { if (!$seen.ContainsKey($key)) { $rewritten += "$key=$($changes[$key])" } }
  $mcp = Read-PanelJson (Join-Path $Root 'mcp/mcp.json')
  Set-PanelProperty $mcp 'port' $mcpPort
  Set-PanelProperty $mcp 'publicUrl' "http://127.0.0.1:$mcpPort/mcp"
  Set-PanelProperty $mcp 'bridgeUrl' "http://127.0.0.1:$bridgePort/bridge"
  if (!$mcp.agent) { Set-PanelProperty $mcp 'agent' ([pscustomobject]@{}) }
  foreach ($entry in @{enabled=[bool]$InputValues.agentEnabled;backend=[string]$InputValues.backend;executable=[string]$InputValues.executable;concurrency=$concurrency;timeoutSeconds=$timeout}.GetEnumerator()) { Set-PanelProperty $mcp.agent $entry.Key $entry.Value }
  $writes = @{'server.properties'=($rewritten -join "`r`n")+"`r`n";'mcp/mcp.json'=($mcp | ConvertTo-Json -Depth 32);'.panel-settings.json'=(@{minMemoryGb=$minimum;maxMemoryGb=$maximum} | ConvertTo-Json)}
  foreach ($relative in @('mcp/paper-mcp.json','plugins/BuilderVillager/mcp.json')) {
    if (Test-Path -LiteralPath (Join-Path $Root $relative)) {
      $fragment = Read-PanelJson (Join-Path $Root $relative)
      foreach ($entry in @{port=$mcpPort;bridgePort=$bridgePort;publicUrl="http://127.0.0.1:$mcpPort/mcp"}.GetEnumerator()) { Set-PanelProperty $fragment $entry.Key $entry.Value }
      $writes[$relative] = $fragment | ConvertTo-Json -Depth 32
    }
  }
  $jar = Get-PanelJar $Root 'paper'
  if ($jar) {
    $java = Get-PanelJava $Root
    $writes['start-paper.cmd'] = (@('@echo off','chcp 65001 >nul','setlocal','cd /d "%~dp0"','if exist "%~dp0mcp\secret.txt" set /p BUILDER_MCP_BRIDGE_SECRET=<"%~dp0mcp\secret.txt"','if not exist "%~dp0logs" mkdir "%~dp0logs"',('"'+$java+'" -Xms'+$minimum+'G -Xmx'+$maximum+'G -jar "%~dp0'+$jar.Name+'" --nogui >> "%~dp0logs\panel-console.log" 2>&1'),'') -join "`r`n")
  }
  $backup = Join-Path $Root ('config-backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6))
  $original = @{}
  foreach ($relative in $writes.Keys) {
    $file = Join-Path $Root $relative
    if (Test-Path -LiteralPath $file) {
      $original[$relative] = Read-PanelText $file
      $destination = Join-Path $backup $relative
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -LiteralPath $file -Destination $destination
    }
  }
  $written = @()
  try { foreach ($relative in $writes.Keys) { Write-PanelAtomic (Join-Path $Root $relative) $writes[$relative]; $written += $relative } }
  catch { foreach ($relative in $written) { if ($original.ContainsKey($relative)) { Write-PanelAtomic (Join-Path $Root $relative) $original[$relative] } }; throw }
  return $backup
}
function Get-PanelProcesses([string]$Root) {
  $searcher=[Management.ManagementObjectSearcher]::new("SELECT ProcessId, ParentProcessId, CommandLine, WorkingSetSize, CreationDate FROM Win32_Process WHERE Name='java.exe' OR Name='javaw.exe'")
  try {
    $java=@(foreach ($item in $searcher.Get()) {
      [pscustomobject]@{ProcessId=[int]$item.ProcessId;ParentProcessId=[int]$item.ParentProcessId;CommandLine=[string]$item.CommandLine;WorkingSetSize=[double]$item.WorkingSetSize;CreationDate=[Management.ManagementDateTimeConverter]::ToDateTime([string]$item.CreationDate)}
    })
  } finally { $searcher.Dispose() }
  $result = @{}
  foreach ($kind in @('paper','mcp')) {
    $jar = Get-PanelJar $Root $kind
    $matches = @()
    if ($jar) { $expected=$jar.FullName.Replace('/','\'); $matches=@($java | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/','\').IndexOf($expected,[StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
    $result[$kind] = $matches
  }
  return $result
}
function Test-PanelPort([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try { $pending=$client.BeginConnect('127.0.0.1',$Port,$null,$null); if (!$pending.AsyncWaitHandle.WaitOne(120)) { return $false }; $client.EndConnect($pending); return $true } catch { return $false } finally { $client.Dispose() }
}
