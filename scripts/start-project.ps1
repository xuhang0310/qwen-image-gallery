$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$RunDir = Join-Path $ProjectDir '.run'
$NoBrowser = $env:WORKBENCH_NO_BROWSER -eq '1'
$PowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$LaunchLog = Join-Path $RunDir 'launch.log'
$PathHash = [System.Security.Cryptography.SHA256]::Create()
try {
  $LockId = [BitConverter]::ToString($PathHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($ProjectDir.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
} finally { $PathHash.Dispose() }
$LaunchMutex = New-Object System.Threading.Mutex($false, "Local\InfiniteCanvas-$LockId")
$HasLock = $false

function Write-LaunchLog([string]$Message) {
  Add-Content -LiteralPath $LaunchLog -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message" -Encoding UTF8
}

function Start-LaunchStep([string]$Name, [string]$ScriptPath, [string]$ScriptArguments, [string]$LogName) {
  Write-LaunchLog "正在启动 $Name"
  $OutputLog = Join-Path $RunDir "$LogName.log"
  $ErrorLog = Join-Path $RunDir "$LogName.err.log"
  $Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" $ScriptArguments"
  $Helper = Start-Process -FilePath $PowerShellPath -ArgumentList $Arguments -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $OutputLog -RedirectStandardError $ErrorLog
  $Helper.Handle | Out-Null
  # Wait for the launcher only; the service it starts stays running.
  $Helper.WaitForExit()
  if ($Helper.ExitCode -ne 0) {
    $Details = (Get-Content -LiteralPath $ErrorLog -Tail 12 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
    throw "$Name 启动失败。日志：$ErrorLog`n$Details"
  }
  Write-LaunchLog "$Name 已就绪"
}

try {
  try { $HasLock = $LaunchMutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $HasLock = $true }
  if (-not $HasLock) { exit 0 }
  Write-LaunchLog '一键启动项目'
  # Browser opens only after both services are ready.
  $env:WORKBENCH_NO_BROWSER = '1'
  Start-LaunchStep 'ComfyUI 视频引擎' (Join-Path $ProjectDir 'services.ps1') 'start comfy' 'launch-comfyui'
  Start-LaunchStep '无限画布网页' (Join-Path $PSScriptRoot 'start-workbench.ps1') '' 'launch-web'
  $Config = Get-Content -LiteralPath (Join-Path $ProjectDir 'shared\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $WebPort = if ($env:PORT) { [int]$env:PORT } else { [int]$Config.port }
  $WebUrl = "http://127.0.0.1:$WebPort/"
  if (-not $NoBrowser) { Start-Process $WebUrl }
  Write-LaunchLog "启动完成：$WebUrl"
} catch {
  $Failure = $_.Exception.Message
  Write-LaunchLog $Failure
  if (-not $NoBrowser) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("$Failure`n`n启动日志：$LaunchLog", '无限画布启动失败', 'OK', 'Error') | Out-Null
  }
  Write-Error $Failure -ErrorAction Continue
  exit 1
} finally {
  if ($HasLock) { $LaunchMutex.ReleaseMutex() }
  $LaunchMutex.Dispose()
}
