@echo off
REM ============================================================
REM AutoTest dev environment (hot reload)
REM  - uvicorn --reload on :4000  (backend, own console window)
REM  - vite dev server on :5173   (frontend, own console window)
REM    vite proxies /api and /ws to :4000 (see ui/vite.config.ts)
REM Use http://localhost:5173 during development.
REM ASCII-only on purpose: Chinese in .bat corrupts under cmd GBK.
REM ============================================================
setlocal
set "HERE=%~dp0"
for /f "delims=" %%d in ("%HERE%..") do set "ROOT=%%~fd"
set "PYEXE=%ROOT%\.venv\Scripts\python.exe"

if not exist "%PYEXE%" (
  echo [dev] error: %PYEXE% not found - create the venv first.
  exit /b 1
)

REM refuse to start a second :4000 (the reload worker would clash)
powershell -NoProfile -Command "if(Test-NetConnection -ComputerName 127.0.0.1 -Port 4000 -InformationLevel Quiet -WarningAction SilentlyContinue){exit 0}else{exit 1}" >nul 2>&1
if not errorlevel 1 (
  echo [dev] :4000 already in use - stop the production backend first (see data\logs_autotest_4000.log).
  exit /b 1
)

echo [dev] starting backend (uvicorn --reload) on :4000 ...
start "AutoTest-Backend-DEV" /min /D "%ROOT%" cmd /c ""%PYEXE%" -m uvicorn autotest.api.server:app --host 127.0.0.1 --port 4000 --reload"

echo [dev] starting vite dev server on :5173 ...
cd /d "%ROOT%\ui"
call npm run dev
endlocal
exit /b 0
