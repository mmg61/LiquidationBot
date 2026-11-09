@echo off
cd /d "%~dp0bot"

:: Eger 3000 portunda acik eski bir panel sureci varsa kapat
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Arka planda hicbir CMD penceresi gorunmeden (Hidden) sunucuyu baslat
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList '.\node_modules\ts-node\dist\bin.js','src\dashboard.ts' -WorkingDirectory '%~dp0bot' -WindowStyle Hidden"

:: Tarayiciyi ac ve bu pencereyi aninda kapat
timeout /t 1 /nobreak >nul
start http://127.0.0.1:3000
exit
