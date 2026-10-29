@echo off
chcp 65001 >nul
title 安装 magpie-chat 开机自启
cd /d "%~dp0"
echo.
echo   在「启动」文件夹里放一个快捷方式，
echo   以后开机会自动在后台起对话服务（不弹窗口）。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
echo.
pause >nul
