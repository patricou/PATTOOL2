@echo off
REM MongoDB Migration Script (Batch File Version)
REM Migrates data from MongoDB v4 (port 27017) to MongoDB 8.2 (port 27018)

set SOURCE_HOST=192.168.1.33
set SOURCE_PORT=27017
set TARGET_HOST=192.168.1.33
set TARGET_PORT=27018
set DATABASE=rando
set BACKUP_DIR=.\mongodb-backup
set MONGO_TOOLS_PATH=C:\MongoDB\mongodb-database-tools-windows-x86_64-100.13.0

echo =========================================
echo MongoDB Migration Script
echo =========================================
echo.
echo Source: %SOURCE_HOST%:%SOURCE_PORT%/%DATABASE%
echo Target: %TARGET_HOST%:%TARGET_PORT%/%DATABASE%
echo MongoDB Tools: %MONGO_TOOLS_PATH%
echo.

REM Set MongoDB tools paths
set MONGODUMP_PATH=%MONGO_TOOLS_PATH%\bin\mongodump.exe
set MONGORESTORE_PATH=%MONGO_TOOLS_PATH%\bin\mongorestore.exe

REM Check if mongodump is available
if not exist "%MONGODUMP_PATH%" (
    echo [ERROR] mongodump not found at: %MONGODUMP_PATH%
    echo Please verify the MongoDB Database Tools path is correct.
    pause
    exit /b 1
)
echo [OK] mongodump found at: %MONGODUMP_PATH%

REM Check if mongorestore is available
if not exist "%MONGORESTORE_PATH%" (
    echo [ERROR] mongorestore not found at: %MONGORESTORE_PATH%
    echo Please verify the MongoDB Database Tools path is correct.
    pause
    exit /b 1
)
echo [OK] mongorestore found at: %MONGORESTORE_PATH%

REM Create backup directory
if exist "%BACKUP_DIR%" (
    echo [INFO] Backup directory exists: %BACKUP_DIR%
    set /p REMOVE="Do you want to remove existing backup? (y/N): "
    if /i "%REMOVE%"=="y" (
        rmdir /s /q "%BACKUP_DIR%"
        echo [OK] Removed existing backup directory
    ) else (
        echo [INFO] Using existing backup directory
    )
) else (
    mkdir "%BACKUP_DIR%"
    echo [OK] Created backup directory: %BACKUP_DIR%
)

REM Step 1: Dump data from source MongoDB
echo.
echo Step 1: Dumping data from MongoDB v4...
echo ----------------------------------------
echo Executing: %MONGODUMP_PATH% --host %SOURCE_HOST% --port %SOURCE_PORT% --db %DATABASE% --out "%BACKUP_DIR%"

"%MONGODUMP_PATH%" --host %SOURCE_HOST% --port %SOURCE_PORT% --db %DATABASE% --out "%BACKUP_DIR%"
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Data dump failed
    pause
    exit /b 1
)
echo [OK] Data dump completed successfully

REM Step 2: Restore data to target MongoDB
echo.
echo Step 2: Restoring data to MongoDB 8.2...
echo ----------------------------------------
echo [WARNING] This will DROP existing data in the target database!
set /p CONTINUE="Continue? (y/N): "
if /i not "%CONTINUE%"=="y" (
    echo [INFO] Migration cancelled by user
    pause
    exit /b 0
)

set DUMP_PATH=%BACKUP_DIR%\%DATABASE%
echo Executing: %MONGORESTORE_PATH% --host %TARGET_HOST% --port %TARGET_PORT% --db %DATABASE% --drop "%DUMP_PATH%"

"%MONGORESTORE_PATH%" --host %TARGET_HOST% --port %TARGET_PORT% --db %DATABASE% --drop "%DUMP_PATH%"
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Data restore failed
    pause
    exit /b 1
)
echo [OK] Data restore completed successfully

echo.
echo =========================================
echo Migration completed!
echo =========================================
echo.
echo Next steps:
echo 1. Verify data in MongoDB 8.2 (port 27018)
echo 2. Update application.properties to use port 27018 (already done)
echo 3. Test the application with the new MongoDB instance
echo 4. Once verified, you can stop MongoDB v4
echo.
echo Backup location: %BACKUP_DIR%
echo.
pause

