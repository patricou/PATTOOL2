@echo off
REM Spring Boot Application Startup Script with Memory Configuration
REM This script configures JVM memory settings to prevent out-of-memory errors

echo Starting PATTOOL Backend Application...
echo.

REM Set JVM memory options
REM -Xms: Initial heap size
REM -Xmx: Maximum heap size
REM -XX:MaxMetaspaceSize: Maximum metaspace size (for class metadata)
REM -XX:MaxDirectMemorySize: Maximum direct memory (for NIO buffers)
REM -XX:+UseG1GC: Use G1 garbage collector
REM -XX:MaxGCPauseMillis: Target max GC pause time
REM -XX:+HeapDumpOnOutOfMemoryError: Create heap dump on OOM
REM -XX:HeapDumpPath: Location for heap dumps

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

REM Create logs directory if it doesn't exist
if not exist "logs" mkdir logs

REM Run the application
java %JAVA_OPTS% -jar target\pattool-0.0.1-SNAPSHOT.jar

pause

