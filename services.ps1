param(
  [Parameter(Position=0)][ValidateSet('start','stop','restart','status')][string]$Action='status',
  [Parameter(Position=1)][ValidateSet('all','comfy','web')][string]$Target='all'
)
$ErrorActionPreference='Stop'
$ProjectDir=$PSScriptRoot
$DefaultConfig=Get-Content -LiteralPath (Join-Path $ProjectDir 'shared\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Config=$DefaultConfig
if ($env:WORKBENCH_CONFIG) {
  $Overrides=Get-Content -LiteralPath $env:WORKBENCH_CONFIG -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach($Property in $Overrides.PSObject.Properties) { $Config | Add-Member -NotePropertyName $Property.Name -NotePropertyValue $Property.Value -Force }
}
$ComfyBase=$Config.comfyBase
$ComfyPython=Join-Path $ComfyBase '.venv\Scripts\python.exe'
$ComfyMain=$Config.comfyMain
$ComfyUrl=if($env:COMFYUI_BASE_URL){$env:COMFYUI_BASE_URL.TrimEnd('/')}else{$Config.comfyUrl}
$ComfyPort=([uri]$ComfyUrl).Port
$WebPort=if($env:PORT){[int]$env:PORT}else{[int]$Config.port}
$RunDir=Join-Path $ProjectDir '.run'
$ServerPath=Join-Path $ProjectDir 'server.js'
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
function Get-PortOwner([int]$Port) { $Connection=Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1; if($Connection){return $Connection.OwningProcess} }
function Get-Command([int]$ProcessId) { return (Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue).CommandLine }
function Test-Owned([int]$ProcessId,[string]$Script) { $Command=Get-Command $ProcessId; return $Command -and $Command -match [regex]::Escape($Script) }
function Stop-ServiceProcess([string]$Name,[int]$Port,[string]$PidFile,[string]$Script) {
  $Candidates=@();if(Test-Path -LiteralPath $PidFile){$Recorded=(Get-Content -LiteralPath $PidFile -Raw).Trim();if($Recorded -match '^\d+$' -and (Test-Owned ([int]$Recorded) $Script)){$Candidates+=[int]$Recorded}}
  $Owner=Get-PortOwner $Port;if($Owner -and (Test-Owned $Owner $Script)){$Candidates+=$Owner}
  foreach($ProcessId in ($Candidates|Select-Object -Unique)){Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue;Write-Host "$Name : 已停止 ($ProcessId)"}
  if($Owner -and -not ($Candidates -contains $Owner)){throw "$Name : 端口 $Port 由其他进程占用，未停止该进程"}
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}
function Start-ServiceProcess([string]$Name,[int]$Port,[string]$PidFile,[string]$Executable,[string[]]$Arguments,[string]$Directory,[string]$Script,[string]$Log) {
  $Owner=Get-PortOwner $Port;if($Owner){if(-not(Test-Owned $Owner $Script)){throw "$Name : 端口 $Port 被其他程序占用"};Write-Host "$Name : 已运行 ($Owner)";return}
  $Process=Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $Directory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $RunDir "$Log.log") -RedirectStandardError (Join-Path $RunDir "$Log.err.log")
  Set-Content -LiteralPath $PidFile -Value $Process.Id;Write-Host "$Name : 已启动 ($($Process.Id))"
}
function Wait-Ready([string]$Url,[int]$Seconds=180) {
  $Deadline=(Get-Date).AddSeconds($Seconds)
  while((Get-Date)-lt $Deadline){try{Invoke-RestMethod -Uri $Url -TimeoutSec 3 | Out-Null;return}catch{Start-Sleep -Seconds 2}}
  throw "服务启动超时: $Url，查看 $RunDir 的日志"
}
$ComfyPidFile=Join-Path $RunDir 'comfyui.pid'
$WebPidFile=Join-Path $RunDir 'web.pid'
$DoComfy=$Target -in @('all','comfy');$DoWeb=$Target -in @('all','web')
if($Action -in @('stop','restart')){
  if($DoWeb){Stop-ServiceProcess '工作台' $WebPort $WebPidFile $ServerPath}
  if($DoComfy){Stop-ServiceProcess 'ComfyUI' $ComfyPort $ComfyPidFile $ComfyMain}
}
if($Action -in @('start','restart')){
  if($DoComfy){if(-not(Test-Path -LiteralPath $ComfyPython) -or -not(Test-Path -LiteralPath $ComfyMain)){throw 'ComfyUI 路径不存在，请修改 shared/config.json'};Start-ServiceProcess 'ComfyUI' $ComfyPort $ComfyPidFile $ComfyPython @(('"'+$ComfyMain+'"'),'--port',"$ComfyPort",'--base-directory',('"'+$ComfyBase+'"')) $ComfyBase $ComfyMain 'comfyui';Wait-Ready "$ComfyUrl/system_stats"}
  if($DoWeb){Push-Location $ProjectDir;try{& npm.cmd run build;if($LASTEXITCODE-ne 0){throw '前端构建失败'}}finally{Pop-Location};Start-ServiceProcess '工作台' $WebPort $WebPidFile 'node' @(('"'+$ServerPath+'"')) $ProjectDir $ServerPath 'web';Wait-Ready "http://127.0.0.1:$WebPort/api/health" 30}
}
if($Action -eq 'status'){
  if($DoComfy){$Owner=Get-PortOwner $ComfyPort;Write-Host "ComfyUI : 端口 $ComfyPort，进程 $Owner"}
  if($DoWeb){$Owner=Get-PortOwner $WebPort;Write-Host "工作台 : 端口 $WebPort，进程 $Owner";try{$Health=Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/api/health" -TimeoutSec 5;Write-Host "ComfyUI 连接: $($Health.connected)"}catch{Write-Host '健康检查未通过'}}
}
