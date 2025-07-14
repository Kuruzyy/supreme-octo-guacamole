@echo off
setlocal

:: Check if node_modules folder exists
if not exist node_modules (
    echo Installing dependencies...
    npm install
)

echo Starting server...
start "" cmd /c "node server.js"

:: Wait briefly to ensure the server starts before opening the browser
timeout /t 3 /nobreak > nul

echo Launching browser...
start http://localhost:3000

endlocal
