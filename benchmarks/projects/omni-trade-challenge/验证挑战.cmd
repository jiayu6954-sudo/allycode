@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo 正在运行 OmniTrade 固定黑盒验收器...
node .challenge\run-all.mjs
echo.
echo 详细报告：.challenge-results\latest.json
pause
endlocal
