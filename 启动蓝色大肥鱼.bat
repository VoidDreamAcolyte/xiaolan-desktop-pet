@echo off
title 蓝色大肥鱼 - 启动器
cd /d "%~dp0"
echo 正在启动蓝色大肥鱼...
start "" "%~dp0node_modules\electron\dist\electron.exe" .
echo 已启动。鱼会出现在屏幕右下角并来回游动。
echo 如果一时找不到，点任务栏右下角托盘区的鱼图标（可能藏在向上箭头里），右键它可打开设置或退出。
timeout /t 3 >nul
