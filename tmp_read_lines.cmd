@echo off
setlocal DisableDelayedExpansion

if "%~1"=="" (
  echo Usage: tmp_read_lines.cmd FILE [START_LINE] [COUNT]
  exit /b 1
)

set "file=%~1"
set /a start=%~2
if "%~2"=="" set /a start=1
set /a count=%~3
if "%~3"=="" set /a count=200
if %start% LSS 1 set /a start=1
if %count% LSS 1 set /a count=1
set /a end=start+count-1

set /a n=0
for /f "usebackq delims=" %%L in ("%file%") do (
  set /a n+=1
  call :maybe_emit %%n%% "%%L"
)

exit /b 0

:maybe_emit
if %1 LSS %start% exit /b 0
if %1 GTR %end% exit /b 0
echo %1: %~2
exit /b 0
