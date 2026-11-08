@echo off
rem Overseas AI supply-chain news refresh (called by Task Scheduler every 6 hours).
setlocal
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0.."

set "PY=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
if not exist "%PY%" set "PY=python"

rem Python writes logs/news-update.log itself; no shared handle here.
"%PY%" scripts\overseas_news.py
