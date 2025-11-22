@echo off
REM Spring Boot Development Mode Startup Script with Memory Configuration
REM This script runs the application using Maven with proper JVM memory settings

echo Starting PATTOOL Backend Application in Development Mode...
echo.

REM Set JVM memory options for Maven
set MAVEN_OPTS=-Xms512m ^
    -Xmx2048m ^
    -XX:MaxMetaspaceSize=512m ^
    -XX:MaxDirectMemorySize=512m ^
    -XX:+UseG1GC ^
    -XX:MaxGCPauseMillis=200 ^
    -XX:+HeapDumpOnOutOfMemoryError ^
    -XX:HeapDumpPath=./logs/heapdump.hprof ^
    -Dfile.encoding=UTF-8

REM Create logs directory if it doesn't exist
if not exist "logs" mkdir logs

REM Run the application using Maven
call mvn spring-boot:run

pause

