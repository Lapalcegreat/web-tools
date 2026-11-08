@echo off
rem Incremental A-share broad-based ETF daily bar update (called by Task Scheduler).
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"

set "PY=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=python"

echo [%date% %time%] start >> "logs\etf-update.log"
"%PY%" scripts\fetch_etf.py >> "logs\etf-update.log" 2>&1
if exist "scripts\cycle_score.py" "%PY%" scripts\cycle_score.py >> "logs\etf-update.log" 2>&1
echo [%date% %time%] exit=%ERRORLEVEL% >> "logs\etf-update.log"

if not exist G:\AI-Tools\_local\publish-data.bat goto :eof
call G:\AI-Tools\_local\publish-data.bat >> logs\etf-update.log 2>&1
echo [%date% %time%] publish_exit=%ERRORLEVEL% >> logs\etf-update.log
