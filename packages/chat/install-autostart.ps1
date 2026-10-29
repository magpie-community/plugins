# 在「启动」文件夹里放一个指向 start-server.vbs 的快捷方式
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $root 'start-server.vbs'
if (-not (Test-Path $vbs)) { Write-Host '找不到 start-server.vbs'; exit 1 }
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'magpie-chat 对话服务.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = $vbs
$s.WorkingDirectory = $root
$s.Description = 'magpie 对话页面的本地服务'
$s.Save()
if (Test-Path $lnk) {
  Write-Host ''
  Write-Host '  已安装开机自启：' -ForegroundColor Green
  Write-Host "  $lnk"
  Write-Host '  下次开机会自动在后台启动。想立刻测试就双击 start-server.vbs。'
} else {
  Write-Host '  安装失败，请手动把 start-server.vbs 的快捷方式放进 shell:startup' -ForegroundColor Yellow
}
