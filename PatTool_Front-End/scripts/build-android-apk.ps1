# Builds the Android debug APK and publishes it for the Outils download page.
# Output: src/assets/downloads/pattool.apk (picked up by ng build / ng serve).
$ErrorActionPreference = "Stop"
$front = Split-Path -Parent $PSScriptRoot
Set-Location $front

$studioJbr = "C:\Program Files\Android\Android Studio\jbr"
if (Test-Path (Join-Path $studioJbr "bin\java.exe")) {
  $env:JAVA_HOME = $studioJbr
  $env:Path = "$(Join-Path $studioJbr "bin");$env:Path"
}

npm run build:mobile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$bundled = Join-Path $front "www\assets\downloads"
if (Test-Path $bundled) {
  Remove-Item $bundled -Recurse -Force
}

npx cap sync android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location (Join-Path $front "android")
try {
  & .\gradlew.bat assembleDebug
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

$apk = Join-Path $front "android\app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $apk)) {
  Write-Error "APK not found: $apk"
}

$dest = Join-Path $front "src\assets\downloads"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item $apk (Join-Path $dest "pattool.apk") -Force

$item = Get-Item (Join-Path $dest "pattool.apk")
$info = @{
  bytes = $item.Length
  builtAt = $item.LastWriteTimeUtc.ToString("o")
} | ConvertTo-Json
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $dest "pattool-apk.json"), $info.Trim() + "`n", $utf8)

$staticDest = Join-Path (Split-Path $front -Parent) "PatTool_Back-End\src\main\resources\static\assets\downloads"
New-Item -ItemType Directory -Force -Path $staticDest | Out-Null
Copy-Item (Join-Path $dest "pattool.apk") (Join-Path $staticDest "pattool.apk") -Force
Copy-Item (Join-Path $dest "pattool-apk.json") (Join-Path $staticDest "pattool-apk.json") -Force

Write-Host "APK published: $dest\pattool.apk ($($item.Length) bytes)"
