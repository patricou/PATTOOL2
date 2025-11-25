@echo off
REM ===================================================================
REM PATTOOL Backend Application - Development Launch Script
REM ===================================================================
REM This script configures JVM memory settings for development/testing
REM Lower memory settings suitable for development machines
REM ===================================================================

echo.
echo ================================================================
echo   Starting PATTOOL Backend Application (Development Mode)
echo ================================================================
echo.

REM ===================================================================
REM JVM Memory Configuration (Development Settings)
REM ===================================================================
REM Lower memory settings for development machines
REM Adjust -Xmx if you experience OutOfMemoryError during development

set JAVA_OPTS=-Xms512m ^
    -Xmx2048m ^
    -XX:MaxMetaspaceSize=512m ^
    -XX:MaxDirectMemorySize=512m ^
    -XX:+UseG1GC ^
    -XX:MaxGCPauseMillis=200 ^
    -XX:+HeapDumpOnOutOfMemoryError ^
    -XX:HeapDumpPath=./logs/heapdump.hprof ^
    -Dfile.encoding=UTF-8 ^
    -Djdk.tls.client.protocols=TLSv1.2

REM ===================================================================
REM Environment Setup
REM ===================================================================

REM Create logs directory if it doesn't exist
if not exist "logs" (
    echo Creating logs directory...
    mkdir logs
)

REM Try to use system Java (from PATH)
set JAVA_EXE=java

REM Check if JAR file exists
if not exist "pattool-0.0.1-SNAPSHOT.jar" (
    echo.
    echo ERROR: JAR file not found: pattool-0.0.1-SNAPSHOT.jar
    echo Please build the application first: mvn clean package
    echo.
    pause
    exit /b 1
)

REM ===================================================================
REM Display Configuration
REM ===================================================================
echo Configuration:
echo   Java: %JAVA_EXE%
echo   JAR: pattool-0.0.1-SNAPSHOT.jar
echo   Memory: 512MB initial, 2GB maximum (Development)
echo   GC: G1GC
echo   Heap Dump: Enabled (./logs/heapdump.hprof)
echo.
echo ================================================================
echo.

REM ===================================================================
REM Launch Application
REM ===================================================================
"%JAVA_EXE%" %JAVA_OPTS% -jar pattool-0.0.1-SNAPSHOT.jar

REM ===================================================================
REM Handle Exit
REM ===================================================================
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ================================================================
    echo   Application exited with error code: %ERRORLEVEL%
    echo ================================================================
    echo.
    echo Check logs for details:
    echo   - Application logs: logs/spring.log (if configured)
    echo   - Heap dump (if OOM): logs/heapdump.hprof
    echo.
) else (
    echo.
    echo ================================================================
    echo   Application stopped normally
    echo ================================================================
    echo.
)

pause

