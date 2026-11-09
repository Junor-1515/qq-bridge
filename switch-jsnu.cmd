@echo off
chcp 65001 >nul
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" scripts\switch-model.mjs jsnu
echo.
pause
