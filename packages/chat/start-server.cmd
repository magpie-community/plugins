@echo off
chcp 65001 >nul
title magpie-chat 对话服务
cd /d "%~dp0"
echo.
echo   正在启动 magpie 对话服务...
echo.
node serve.mjs
echo.
echo   服务已停止。按任意键关闭。
pause >nul
