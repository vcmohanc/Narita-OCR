@echo off
setlocal

echo ========================================
echo  OCR Server Restart
echo ========================================

echo Stopping Python processes...
taskkill /F /IM python.exe /T >nul 2>&1
taskkill /F /IM pythonw.exe /T >nul 2>&1
timeout /t 3 /nobreak >nul

REM Check if port 8080 is free
netstat -ano | findstr ":8080 " | findstr LISTEN >nul 2>&1
if %ERRORLEVEL% == 0 (
    echo Port 8080 still in use — trying to free it...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080 "') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
)

REM Try port 8080 first
netstat -ano | findstr ":8080 " | findstr LISTEN >nul 2>&1
if %ERRORLEVEL% == 0 (
    echo.
    echo WARNING: Port 8080 is still occupied by another process.
    echo Starting OCR server on port 8081 instead...
    echo.
    echo After the server starts, open your browser at:
    echo   http://localhost:8081
    echo.
    cd /d %~dp0
    start "OCR Server (port 8081)" cmd /k "venv\Scripts\python.exe -m uvicorn backend.main:app --host 0.0.0.0 --port 8081"
    echo Done! Look for "MySQL persistence enabled" in the new OCR Server window.
    echo Then navigate to http://localhost:8081
) else (
    echo Starting OCR server on port 8080...
    cd /d %~dp0
    start "OCR Server" cmd /k "venv\Scripts\python.exe -m uvicorn backend.main:app --host 0.0.0.0 --port 8080"
    echo Done! Look for "MySQL persistence enabled" in the new OCR Server window.
)

pause
