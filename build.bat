@echo off
rem Build GPXSee with Qt 6.8.3 (MSVC 2022 x64) + VS Build Tools 2026
setlocal

set "QTDIR=C:\Qt\6.8.3\msvc2022_64"
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
set "SRC=C:\Claude\38_GPX_viewer\GPXSee"
set "BUILD=C:\Claude\38_GPX_viewer\build"

echo === Setting up MSVC x64 environment ===
call "%VCVARS%" x64
if errorlevel 1 exit /b 1

set "PATH=%QTDIR%\bin;%PATH%"

echo.
echo === lrelease (compiling translations) ===
"%QTDIR%\bin\lrelease.exe" "%SRC%\gpxsee.pro"
if errorlevel 1 exit /b 1

if not exist "%BUILD%" mkdir "%BUILD%"
cd /d "%BUILD%"

echo.
echo === qmake ===
"%QTDIR%\bin\qmake.exe" "%SRC%\gpxsee.pro" CONFIG+=release
if errorlevel 1 exit /b 1

echo.
echo === nmake ===
nmake /NOLOGO
if errorlevel 1 exit /b 1

echo.
echo === BUILD OK ===
