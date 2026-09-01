@echo off
rem Build the process-audio capture sidecar. Finds VS Build Tools via vswhere so it works on
rem any machine with the C++ workload installed, not just this one.
setlocal
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH (
  echo Visual Studio C++ Build Tools not found.
  exit /b 1
)
call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
cl /nologo /EHsc /O2 /std:c++17 weave-audio-capture.cpp /Fe:weave-audio-capture.exe /link ole32.lib mmdevapi.lib user32.lib || exit /b 1
del /q weave-audio-capture.obj 2>nul
echo Built weave-audio-capture.exe
endlocal
