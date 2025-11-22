@echo off
REM Check Windows Paging File Configuration
echo ========================================
echo Windows Paging File Information
echo ========================================
echo.

echo Current Paging File Settings:
wmic pagefileset get name,InitialSize,MaximumSize
echo.

echo Total Physical Memory:
wmic computersystem get TotalPhysicalMemory
echo.

echo Available Physical Memory:
wmic OS get FreePhysicalMemory
echo.

echo.
echo ========================================
echo Recommendations:
echo ========================================
echo If InitialSize is less than 4096 MB, you should increase it.
echo Recommended: Initial=4096MB, Maximum=8192MB or higher
echo.
echo To change: System Properties ^> Advanced ^> Performance Settings ^> Advanced ^> Virtual Memory
echo.
pause

