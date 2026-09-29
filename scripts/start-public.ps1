# 一键公网启动：起 server.js → 起 Cloudflare 隧道 → 打印公网地址
# 用法：右键“使用 PowerShell 运行”，或在 scripts 目录执行 powershell -ExecutionPolicy Bypass -File start-public.ps1
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$tunnelLog = "$env:TEMP\cf-tunnel.log"
$tunnelOut = "$env:TEMP\cf-tunnel.out"
$cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

if (-not (Test-Path $cf)) {
  Write-Host "未找到 cloudflared，请先执行: winget install --id Cloudflare.cloudflared" -ForegroundColor Red
  exit 1
}

# 1. 本地服务
if (-not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Write-Host "[1/2] server.js 已启动 (http://localhost:3000)"
} else {
  Write-Host "[1/2] server.js 已在运行"
}

# 2. 清理旧隧道并启动新隧道（每次 URL 会变）
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item $tunnelLog, $tunnelOut -Force -ErrorAction SilentlyContinue
Start-Process $cf -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:3000' `
  -RedirectStandardError $tunnelLog -RedirectStandardOutput $tunnelOut -WindowStyle Hidden
Write-Host "[2/2] 隧道启动中..."

# 3. 解析公网地址
$url = $null
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline -and -not $url) {
  Start-Sleep -Seconds 2
  $txt = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
  if ($txt -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $url = $Matches[0] }
}

if ($url) {
  Write-Host ""
  Write-Host "公网地址（手机流量也可访问）:" -ForegroundColor Cyan
  Write-Host $url -ForegroundColor Green
  Write-Host ""
  Write-Host "提示：URL 每次重启都会变；本脚本关闭后隧道仍保持运行；电脑关机则网站下线。" -ForegroundColor DarkGray
} else {
  Write-Host "40 秒内未取到地址，日志见 $tunnelLog" -ForegroundColor Yellow
}
