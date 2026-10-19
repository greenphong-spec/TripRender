@echo off
rem Deploy Qt runtime + GPXSee data files next to the built executable.
rem On Windows QStandardPaths::AppDataLocation includes <appdir>\data,
rem so CRS / maps / style / symbols / translations live under release\data.
setlocal

set "QTDIR=C:\Qt\6.8.3\msvc2022_64"
set "SRC=C:\Claude\38_GPX_viewer\GPXSee"
set "OUT=C:\Claude\38_GPX_viewer\build\release"

echo === windeployqt ===
"%QTDIR%\bin\windeployqt.exe" --release --no-compiler-runtime "%OUT%\GPXSee.exe"
if errorlevel 1 exit /b 1

echo.
echo === copying application data ===
xcopy /E /I /Q /Y "%SRC%\data\CRS"   "%OUT%\data\CRS"   >nul
xcopy /E /I /Q /Y "%SRC%\data\maps"  "%OUT%\data\maps"  >nul
xcopy /E /I /Q /Y "%SRC%\data\style" "%OUT%\data\style" >nul

if not exist "%OUT%\data\symbols" mkdir "%OUT%\data\symbols"
copy /Y "%SRC%\icons\symbols\*.png" "%OUT%\data\symbols\" >nul

if not exist "%OUT%\data\translations" mkdir "%OUT%\data\translations"
copy /Y "%SRC%\lang\*.qm" "%OUT%\data\translations\" >nul

echo === DEPLOY OK ===
