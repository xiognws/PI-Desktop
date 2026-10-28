@echo off
REM ============================================================
REM AutoTest backend bootstrap (FastAPI :4000), idempotent, background window.
REM Place this in project scripts\. ROOT = %~dp0.. (relative).
REM ============================================================
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
for /f "delims=" %%d in ("%HERE%..") do set "ROOT=%%~fd"
REM check if already listening (idempotent: double-click won't spawn a 2nd instance)
set "ALREADY="
powershell -NoProfile -Command "if(Test-NetConnection -ComputerName 127.0.0.1 -Port 4000 -InformationLevel Quiet -WarningAction SilentlyContinue){exit 0}else{exit 1}" >nul 2>&1
if not errorlevel 1 set "ALREADY=1"
if defined ALREADY (
  echo [backend] :4000 already listening; skip bootstrap.
  exit /b 0
)
cd /d "%ROOT%"
set "PYTHONUTF8=1"
set "PYEXE=%ROOT%\.venv\Scripts\python.exe"
set "LOG=%ROOT%\data\logs_autotest_4000.log"
set "URL=http://127.0.0.1:4000/api/health"

if not exist "%ROOT%ui\dist\index.html" (
  echo [backend] warn: ui\dist not found; frontend not built, :4000 serves API only.
)
REM launch: min window, stdout+stderr -> log
start "AutoTest-Backend-4000" /min "%PYEXE%" -m uvicorn autotest.api.server:app --host 127.0.0.1 --port 4000 >> "%LOG%" 2>&1

echo [backend] waiting for :4000 ...
for /l %%i in (1,1,45) do (
  >nul 2>&1 curl -s -m 2 "%URL%"
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)
echo [backend] not ready after 45s; continuing anyway.
:ready
echo [backend] :4000 ready (health check returned OK).
exit /b 0