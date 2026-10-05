$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$ProgressPreference = 'SilentlyContinue'
$NoBrowser = $env:WORKBENCH_NO_BROWSER -eq '1'
$RunDir = Join-Path $ProjectDir '.run'
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$env:PATH = (Join-Path $RunDir 'node') + ';' + $env:PATH
function Test-Node {
  try {
    $NodeVersion = & node -p 'process.versions.node' 2>$null
    $NodeParts=$NodeVersion.Split('.')
    return $LASTEXITCODE -eq 0 -and ([int]$NodeParts[0] -gt 24 -or ([int]$NodeParts[0] -eq 24 -and [int]$NodeParts[1] -ge 14))
  } catch { return $false }
}
if (-not (Test-Node)) {
  if (-not [Environment]::Is64BitOperatingSystem) { throw '需要 64 位 Windows。' }
  Write-Host '首次启动：下载 Node.js 24 官方便携版，不修改系统安装。'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $DownloadSettings=@{}
  if ($env:HTTPS_PROXY) { $DownloadSettings.Proxy=$env:HTTPS_PROXY }
  $NodeReleases = Invoke-RestMethod 'https://nodejs.org/dist/index.json' @DownloadSettings
  $NodeRelease = $NodeReleases | Where-Object { $_.version -match '^v24\.' } | Select-Object -First 1
  if (-not $NodeRelease) { throw '无法找到 Node.js 24 下载，请检查网络。' }
  $NodeArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $NodeName = "node-$($NodeRelease.version)-win-$NodeArch"
  $ZipName = "$NodeName.zip"
  $DownloadUrl = "https://nodejs.org/dist/$($NodeRelease.version)"
  $ArchivePath = Join-Path $RunDir $ZipName
  Invoke-WebRequest "$DownloadUrl/$ZipName" -OutFile $ArchivePath -UseBasicParsing @DownloadSettings
  $Checksums = (Invoke-WebRequest "$DownloadUrl/SHASUMS256.txt" -UseBasicParsing @DownloadSettings).Content
  $ExpectedLine = $Checksums -split "`n" | Where-Object { $_.Trim().EndsWith(" $ZipName") } | Select-Object -First 1
  if (-not $ExpectedLine) { throw '官方校验清单缺失，不运行下载文件。' }
  $ExpectedHash = ($ExpectedLine.Trim() -split '\s+')[0]
  if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ne $ExpectedHash) { throw 'Node.js 文件校验失败，请重新启动以下载。' }
  $NodeStage = Join-Path $RunDir ('node-stage-' + [guid]::NewGuid().ToString('N'))
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $NodeStage
  $NodeTarget = Join-Path $RunDir 'node'
  if (Test-Path -LiteralPath $NodeTarget) {
    $BackupTarget = Join-Path $RunDir ('node-backup-' + [guid]::NewGuid().ToString('N'))
    Move-Item -LiteralPath $NodeTarget -Destination $BackupTarget
  }
  Move-Item -LiteralPath (Join-Path $NodeStage $NodeName) -Destination $NodeTarget
  if (-not (Test-Node)) { throw 'Node.js 无法运行，请检查电脑架构。' }
}
$NodePath = (Get-Command node).Source
$NpmPath = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
$Config = Get-Content -LiteralPath (Join-Path $ProjectDir 'shared\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$WebPort = if ($env:PORT) { [int]$env:PORT } else { [int]$Config.port }
$WebUrl = "http://127.0.0.1:$WebPort"
$Owner = Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($Owner) {
  $ExistingCommand = (Get-CimInstance Win32_Process -Filter "ProcessId=$($Owner.OwningProcess)").CommandLine
  if ($ExistingCommand -notmatch [regex]::Escape((Join-Path $ProjectDir 'server.js'))) { throw "端口 $WebPort 被其他程序占用。请关闭占用程序或修改 PORT。" }
  Write-Host '工作台已在运行，正在打开界面。'
  if (-not $NoBrowser) { Start-Process $WebUrl }
  exit 0
}
Push-Location $ProjectDir
try {
  $LockHash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
  $HashFile = Join-Path $RunDir 'dependencies.sha256'
  $SavedHash = if (Test-Path -LiteralPath $HashFile) { (Get-Content -LiteralPath $HashFile -Raw).Trim() } else { '' }
  if (-not (Test-Path 'node_modules\vue\package.json') -or $LockHash -ne $SavedHash) {
    Write-Host '安装工作台依赖，首次运行需要联网。'
    & $NpmPath ci
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络并重新启动。' }
    Set-Content -LiteralPath $HashFile -Value $LockHash
  }
  Write-Host '准备工作台界面…'
  & $NpmPath run build
  if ($LASTEXITCODE -ne 0) { throw '界面构建失败，请检查上方提示。' }
} finally { Pop-Location }
$ServerPath = Join-Path $ProjectDir 'server.js'
$Process = Start-Process -FilePath $NodePath -ArgumentList @(('"' + $ServerPath + '"')) -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $RunDir 'web.log') -RedirectStandardError (Join-Path $RunDir 'web.err.log')
Set-Content -LiteralPath (Join-Path $RunDir 'web.pid') -Value $Process.Id
for ($Wait = 0; $Wait -lt 30; $Wait++) {
  if ($Process.HasExited) { throw "工作台启动失败，请查看 $RunDir\web.err.log。" }
  try {
    Invoke-RestMethod "$WebUrl/api/config" -TimeoutSec 2 | Out-Null
    Write-Host '工作台已启动。在“环境配置”中安装引擎、下载模型并试生成。'
    if (-not $NoBrowser) { Start-Process $WebUrl }
    exit 0
  } catch { Start-Sleep -Seconds 1 }
}
throw "启动超时，请查看 $RunDir\web.err.log。"
