param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework
$target=Join-Path $Directory 'BuilderVillager.Panel.exe'
if (Test-Path -LiteralPath $target) { exit 0 }
$references=@([Management.Automation.PowerShell].Assembly.Location,[Windows.Application].Assembly.Location,[Windows.UIElement].Assembly.Location,[Windows.DependencyObject].Assembly.Location,'System.Xaml.dll','System.dll','System.Core.dll') | Select-Object -Unique
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $Directory 'host.cs') -Raw -Encoding UTF8) -ReferencedAssemblies $references -OutputAssembly $target -OutputType WindowsApplication
