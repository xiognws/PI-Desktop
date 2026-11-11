@echo off
REM ============================================================
REM AutoTest dev environment (hot reload)
REM   - uvicorn --reload on :4000 (backend)
REM   - vite dev server on :5173 (frontend, needs pnpm install first)
REM Python is the bundled runtime, not a venv; deps live in .deps.
REM ASCII-only on purpose: Chinese in .bat corrupts under cmd GBK.
REM ============================================================
setlocal
set "HERE=%~dp0"
for /f "delims=" %%d in ("%HERE%..") do set "ROOT=%%~fd"
REM ROOT = services\autotest; REPO = repo root (two levels up)
for /f "delims=" %%d in ("%ROOT%\..\..") do set "REPO=%%~fd"

set "PYEXE=%REPO%\apps\desktop\resources\python\runtime\python.exe"
if not exist "%PYEXE%" if defined PI_DESKTOP_PYTHON set "PYEXE=%PI_DESKTOP_PYTHON%"
if not exist "%PYEXE%" (
  echo [dev] error: bundled python not found - set PI_DESKTOP_PYTHON to the runtime python.exe.
  exit /b 1
)
if not exist "%ROOT%\.deps\fastapi" (
  echo [dev] error: .deps is empty - run:
  echo   "%PYEXE%" -m pip install --target "%ROOT%\.deps" -r "%ROOT%\requirements.lock"
  exit /b 1
)

set "PYTHONHOME=%REPO%\apps\desktop\resources\python\runtime"
set "PYTHONPATH=%ROOT%\src;%ROOT%\.deps;%REPO%\apps\desktop\resources\python\site-packages"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
if not defined AUTOTEST_WORKSPACE set "AUTOTEST_WORKSPACE=%ROOT%\data\workspace"
if not defined AUTOTEST_PLATFORM_DB set "AUTOTEST_PLATFORM_DB=%ROOT%\data\platform.db"

REM refuse to start a second :4000 (the reload worker would clash)
powershell -NoProfile -Command "if(Test-NetConnection -ComputerName 127.0.0.1 -Port 4000 -InformationLevel Quiet -WarningAction SilentlyContinue){exit 0}else{exit 1}" >nul 2>&1
if not errorlevel 1 (
  echo [dev] :4000 already in use - stop the other backend first.
  exit /b 1
)

echo [dev] starting backend (uvicorn --reload) on :4000 ...
start "AutoTest-Backend-DEV" /min /D "%ROOT%" cmd /c ""%PYEXE%" -m uvicorn autotest.api.server:app --host 127.0.0.1 --port 4000 --reload"

echo [dev] starting vite dev server on :5173 ...
cd /d "%ROOT%\ui"
call pnpm run dev
endlocal
exit /b 0
