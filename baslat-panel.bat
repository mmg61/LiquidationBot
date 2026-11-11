@echo off
cd /d "%~dp0bot"

:: Eger onceden kalmis acik CMD penceresi veya 3000 portu sureci varsa temizle
taskkill /F /FI "WINDOWTITLE eq AAVE V3 ARBITRUM*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Arka planda hicbir CMD penceresi acmadan (Hidden) yerel sunucuyu baslat
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList '.\node_modules\ts-node\dist\bin.js','src\dashboard.ts' -WorkingDirectory '%~dp0bot' -WindowStyle Hidden"

:: Tarayicida paneli ac ve bu pencereyi aninda kapat
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:3000"
exit
