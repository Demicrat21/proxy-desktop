@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [!] Node.js не найден. Установите LTS с https://nodejs.org и запустите build.bat снова.
  pause & exit /b 1
)

echo [1/3] Установка зависимостей...
call npm install || (echo [!] npm install не удался & pause & exit /b 1)

echo [2/3] Проверка ядра прокси...
call npm test || (echo [!] Тесты не прошли & pause & exit /b 1)

echo [3/3] Сборка .exe...
call npm run dist || (echo [!] Сборка не удалась & pause & exit /b 1)

echo.
echo Готово. Файлы в папке dist\:
dir /b dist\*.exe
start "" dist
pause
