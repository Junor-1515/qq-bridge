# 一键拉起 / 修复 qq-bridge 依赖的本机部件（Windows）
#   1. SnowLuma（OneBot 网关，默认端口 5099 / 3000 / 3001）
#   2. 对齐 DSH 端口：DSH 每次启动端口可能不同，写回 config.json 的 dsh.baseUrl
#   3. qq-bridge（桥接 + 控制台，默认 3100）
#
# 用法（仓库根目录）：
#   .\start-services.cmd                 只补缺失的；DSH 端口变了会自动重启桥接
#   .\start-services.cmd -Restart        强制重启桥接
#   .\start-services.cmd -OpenConsole    启动完成后打开带 token 的控制台
#
# SnowLuma 默认取仓库同级的 ..\SnowLuma，也可用环境变量 SNOWLUMA_DIR 指定。
# 注意：SnowLuma 的安装、启动与扫码以它自己的 EULA 为准；这个脚本只是本机便捷入口。

param(
  [switch]$Restart,
  [switch]$OpenConsole
)

$ErrorActionPreference = 'Stop'

$Root          = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = Split-Path -Parent $Root
$BridgeDir     = $Root
$ConfigPath    = Join-Path $Root 'config.json'

$Node = $null
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $Node = $nodeCmd.Source }
if (-not $Node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $Node = 'C:\Program Files\nodejs\node.exe' }
if (-not $Node) {
  Write-Host '[!] 找不到 node，请先安装 Node.js 22.13+ 或把它加入 PATH。' -ForegroundColor Red
  exit 1
}

$SnowDir = $env:SNOWLUMA_DIR
if (-not $SnowDir) {
  foreach ($candidate in @((Join-Path $WorkspaceRoot 'SnowLuma'), (Join-Path $Root 'SnowLuma'))) {
    if (Test-Path (Join-Path $candidate 'index.mjs')) { $SnowDir = $candidate; break }
  }
}

function Test-LocalPort {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(500) -and $client.Connected) { return $true }
    return $false
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

# DSH 主进程会监听两个端口：一个是真 API（未鉴权访问返回 401），另一个是内部端口（一路 404）。
# 所以判据是「HTTP 有响应且状态码在 2xx~4xx」而不是随便什么端口。
function Get-DshBaseUrl {
  $procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if (-not $procs) { return $null }
  $ports = foreach ($p in $procs) {
    Get-NetTCPConnection -State Listen -OwningProcess $p.Id -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty LocalPort
  }
  foreach ($port in ($ports | Sort-Object -Unique)) {
    try {
      $resp = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) { return "http://127.0.0.1:$port" }
    } catch {
      $code = $null
      try { $code = [int]$_.Exception.Response.StatusCode } catch {}
      if ($code -eq 401 -or $code -eq 403 -or $code -eq 200) { return "http://127.0.0.1:$port" }
    }
  }
  return $null
}

function Get-PidOnPort {
  param([int]$Port)
  (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess)
}

# 守护循环 run-bridge.cmd 的 cmd 进程：重启桥接时要连它一起收掉，
# 否则杀掉 node 之后它 5 秒后又会把旧配置的桥接拉回来。
function Get-BridgeSupervisorPid {
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and (
        $_.CommandLine -match 'run-bridge\.cmd' -or
        ($_.CommandLine -match 'start\.bat' -and $_.CommandLine -match 'qq-bridge')
      )
    } |
    Select-Object -ExpandProperty ProcessId
}

function Start-Detached {
  param([string]$WorkingDir, [string]$Argument, [string]$OutLog, [string]$ErrLog)
  Start-Process -FilePath $Node -ArgumentList $Argument -WorkingDirectory $WorkingDir `
    -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog | Out-Null
}

Write-Host '=== qq-bridge 自检 ===' -ForegroundColor Cyan

# ── 1. DSH 端口对齐 ──────────────────────────────────────────────
$base = Get-DshBaseUrl
if (-not $base) {
  Write-Host '[!] 没找到运行中的 DSH（DeepSeek Harness 没开？）' -ForegroundColor Yellow
  $base = $null
} else {
  Write-Host "[·] DSH 端口：$base"
  $syncScript = Join-Path $Root 'scripts\set-dsh-base.mjs'
  $syncOut = & $Node $syncScript $base 2>&1
  $syncText = [string]($syncOut -join "`n")
  if ($syncText -match '→') {
    Write-Host "[✓] config.json $syncText" -ForegroundColor Green
    $portChanged = $true
  } elseif ($LASTEXITCODE -ne 0) {
    Write-Host "[!] 写 config.json 失败：$syncText" -ForegroundColor Red
    $portChanged = $false
  } else {
    Write-Host '[·] baseUrl 已是最新'
    $portChanged = $false
  }
}

# ── 2. SnowLuma ─────────────────────────────────────────────────
if (Test-LocalPort 3000) {
  Write-Host '[·] SnowLuma 已在运行'
} else {
  Write-Host '[·] 启动 SnowLuma…'
  Start-Detached -WorkingDir $SnowDir -Argument 'index.mjs' `
    -OutLog (Join-Path $SnowDir 'console-out.log') -ErrLog (Join-Path $SnowDir 'console-err.log')
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-LocalPort 3000) { break }
  }
  if (Test-LocalPort 3000) { Write-Host '[✓] SnowLuma 起来了' -ForegroundColor Green }
  else { Write-Host '[!] SnowLuma 没起来，看 SnowLuma\console-err.log' -ForegroundColor Red }
}

# ── 3. qq-bridge ────────────────────────────────────────────────
$bridgePid = Get-PidOnPort 3100
$supPids = @(Get-BridgeSupervisorPid)
if ($portChanged -and $bridgePid -and -not $Restart) {
  Write-Host '[!] DSH 端口变了，桥接还在用旧地址 —— 自动重启让它生效' -ForegroundColor Yellow
  $Restart = $true
}

if ($Restart -and ($bridgePid -or $supPids.Count -gt 0)) {
  Write-Host "[·] 重启桥接（node $bridgePid，守护进程 $($supPids -join ',')）…"
  if ($supPids.Count -gt 0) {
    foreach ($supId in $supPids) { Stop-Process -Id $supId -Force -ErrorAction SilentlyContinue }
  }
  if ($bridgePid) { Stop-Process -Id $bridgePid -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  $bridgePid = $null
}

if (-not $bridgePid) {
  $starter = Join-Path $WorkspaceRoot 'run-bridge.cmd'
  if (-not (Test-Path $starter)) { $starter = Join-Path $Root 'start.bat' }
  Write-Host '[·] 启动 qq-bridge…'
  if (Test-Path $starter) {
    # 走守护循环：node 崩了自己 5 秒后起来，崩溃现场留在 bridge-crash.log
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $starter + '"')) `
      -WorkingDirectory $BridgeDir -WindowStyle Hidden | Out-Null
  } else {
    Start-Detached -WorkingDir $BridgeDir -Argument 'src/bridge.js' `
      -OutLog (Join-Path $BridgeDir 'bridge.log') -ErrLog (Join-Path $BridgeDir 'bridge-err.log')
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-LocalPort 3100) { break }
  }
  if (Test-LocalPort 3100) { Write-Host '[✓] 桥接起来了' -ForegroundColor Green }
  else { Write-Host '[!] 桥接没起来，看 qq-bridge\bridge-err.log' -ForegroundColor Red }
} else {
  Write-Host "[·] 桥接已在运行（PID $bridgePid）"
}

# ── 4. 汇总 ─────────────────────────────────────────────────────
Start-Sleep -Seconds 2
Write-Host ''
Write-Host '端口状态：' -ForegroundColor Cyan
foreach ($p in 5099, 3000, 3001, 3100) {
  $label = switch ($p) {
    5099 { 'SnowLuma WebUI' }
    3000 { 'OneBot HTTP' }
    3001 { 'OneBot WS' }
    3100 { '桥接控制台' }
  }
  $ok = Test-LocalPort $p
  $mark = if ($ok) { 'OK  ' } else { 'DOWN' }
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("  {0,-6} {1,5}  {2}" -f $mark, $p, $label) -ForegroundColor $color
}
if ($base) { Write-Host "  DSH  → $base" }
Write-Host ''
if (Test-LocalPort 3100) {
  $token = ''
  $cfgPath = Join-Path $BridgeDir 'config.json'
  if (Test-Path $cfgPath) {
    try { $token = [string]((Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json).consoleToken) } catch {}
  }
  if (-not $token) {
    $tokenFile = Join-Path $Root 'state\console-token'
    if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
  }
  $consoleUrl = 'http://127.0.0.1:3100/'
  if ($token) { $consoleUrl += '?token=' + [uri]::EscapeDataString($token) }
  Write-Host "桥接控制台：$consoleUrl" -ForegroundColor Cyan
  if ($OpenConsole) { Start-Process $consoleUrl | Out-Null }
  $log = Join-Path $BridgeDir 'bridge.log'
  if (Test-Path $log) {
    Write-Host '--- bridge.log 末尾 ---'
    Get-Content $log -Tail 8 -Encoding UTF8
  }
}
