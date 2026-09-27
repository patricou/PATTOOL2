@echo off
setlocal
REM Importe la chaine GoDaddy et produit tomcat.keystore.jks
REM A lancer depuis le dossier du certificat, par exemple :
REM   S:\patrick\Save_prg_OFFICIAL\Certificat SSL GoDaddy\2026_09_27
REM   C:\Dev\PATTOOL2\scripts\import-godaddy-keystore.bat

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0import-godaddy-keystore.ps1" %*
set ERR=%ERRORLEVEL%
echo.
pause
exit /b %ERR%
