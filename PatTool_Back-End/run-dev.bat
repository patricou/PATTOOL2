@echo off
REM Spring Boot Development Mode Startup Script with Memory Configuration
REM This script runs the application using Maven with proper JVM memory settings

echo Starting PATTOOL Backend Application in Development Mode...
echo.

REM Set JVM memory options for Maven
set MAVEN_OPTS=-Xms256m ^
    -Xmx1536m ^
    -XX:MaxMetaspaceSize=256m ^
    -XX:MaxDirectMemorySize=256m ^
    -XX:+UseG1GC ^
    -XX:MaxGCPauseMillis=200 ^
    -XX:+HeapDumpOnOutOfMemoryError ^
    -XX:HeapDumpPath=./logs/heapdump.hprof ^
    -Dfile.encoding=UTF-8 ^
    -Djdk.tls.client.protocols=TLSv1.2

REM Create logs directory if it doesn't exist
if not exist "logs" mkdir logs

REM Run the application using Maven
call mvn spring-boot:run

pause

