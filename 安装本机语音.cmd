@echo off
chcp 65001 >nul
pushd "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS: https://nodejs.org/
  pause
  popd
  exit /b 1
)
node.exe --use-env-proxy "%~dp0scripts\setup-speech.mjs"
if errorlevel 1 (
  echo Speech setup failed. You can keep studying with text and retry later.
) else (
  echo Local Japanese speech recognition is ready. Refresh the app to continue.
)
pause
popd
