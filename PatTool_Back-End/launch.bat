@echo off
REM ===================================================================
REM PATTOOL Backend Application - Production Launch Script
REM ===================================================================
REM This script configures JVM memory settings to prevent OutOfMemoryError
REM Based on recommendations in MEMORY_CONFIGURATION.md
REM ===================================================================

echo.
echo ================================================================
echo   Starting PATTOOL Backend Application
echo ================================================================
echo.

REM ===================================================================
REM JVM Memory Configuration
REM ===================================================================
REM -Xms: Initial heap size (set equal to -Xmx to prevent resizing overhead)
REM -Xmx: Maximum heap size (adjust based on server capacity)
REM -XX:MaxMetaspaceSize: Maximum metaspace size (for class metadata)
REM -XX:MaxDirectMemorySize: Maximum direct memory (for NIO buffers)
REM -XX:+UseG1GC: Use G1 garbage collector (recommended for Java 11+)
REM -XX:MaxGCPauseMillis: Target max GC pause time (milliseconds)
REM -XX:+HeapDumpOnOutOfMemoryError: Create heap dump on OOM
REM -XX:HeapDumpPath: Location for heap dumps
REM -Dfile.encoding=UTF-8: Set file encoding
REM -Djdk.tls.client.protocols=TLSv1.2: Force TLS 1.2 for compatibility
REM ===================================================================

REM Memory Configuration Options:
REM Development/Low-Load: -Xms512m -Xmx2048m
REM Production (Low Load): -Xms2g -Xmx4g
REM Production (High Load): -Xms4g -Xmx8g
REM
REM Current configuration: Production (Low Load) - 2GB initial, 4GB max
REM Adjust these values based on your server capacity and load

set JAVA_OPTS=-Xms2g ^
    -Xmx4g ^
    -XX:MaxMetaspaceSize=512m ^
    -XX:MaxDirectMemorySize=512m ^
    -XX:+UseG1GC ^
    -XX:MaxGCPauseMillis=200 ^
    -XX:G1HeapRegionSize=16m ^
    -XX:InitiatingHeapOccupancyPercent=45 ^
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

REM Check if Java is available at the specified path
set JAVA_HOME=C:\Program Files\Java\jdk-21
set JAVA_EXE=%JAVA_HOME%\bin\java.exe

if not exist "%JAVA_EXE%" (
    echo.
    echo ERROR: Java not found at %JAVA_EXE%
    echo Please update JAVA_HOME in this script or ensure Java 21 is installed.
    echo.
    echo Trying to use system Java...
    set JAVA_EXE=java
)

REM Check if JAR file exists
if not exist "pattool-0.0.1-SNAPSHOT.jar" (
    echo.
    echo ERROR: JAR file not found: pattool-0.0.1-SNAPSHOT.jar
    echo Please ensure the JAR file is in the same directory as this script.
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
echo   Memory: 2GB initial, 4GB maximum
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

