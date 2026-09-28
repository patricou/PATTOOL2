# Builds the Android release APK and publishes it for the Outils download page.
# A debug APK is marked debuggable and Play Protect blocks the install.
# Output: src/assets/downloads/pattool.apk (picked up by ng build / ng serve).
$ErrorActionPreference = "Stop"
$front = Split-Path -Parent $PSScriptRoot
Set-Location $front

# Gradle 8.14 cannot run on the Android Studio JBR when that JBR is Java 25.
$jdk21 = "C:\Program Files\Java\jdk-21"
$studioJbr = "C:\Program Files\Android\Android Studio\jbr"
if (Test-Path (Join-Path $jdk21 "bin\java.exe")) {
  $env:JAVA_HOME = $jdk21
} elseif (Test-Path (Join-Path $studioJbr "bin\java.exe")) {
  $env:JAVA_HOME = $studioJbr
}
if ($env:JAVA_HOME) {
  $env:Path = "$(Join-Path $env:JAVA_HOME "bin");$env:Path"
}

npm run build:mobile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$bundled = Join-Path $front "www\assets\downloads"
if (Test-Path $bundled) {
  Remove-Item $bundled -Recurse -Force
}

npx cap sync android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$android = Join-Path $front "android"
$keystore = Join-Path $android "pattool-release.keystore"
$props = Join-Path $android "keystore.properties"
if (-not (Test-Path $keystore) -and -not (Test-Path $props)) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 24
  $rng.GetBytes($bytes)
  $pass = ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+', 'A').Replace('/', 'b')
  $keytool = Join-Path $env:JAVA_HOME "bin\keytool.exe"
  & $keytool -genkeypair -v -keystore $keystore -alias pattool -keyalg RSA -keysize 2048 -validity 10000 -storepass $pass -keypass $pass -dname "CN=PatTool, O=PatTool, C=FR"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  $propsText = "storeFile=pattool-release.keystore`nstorePassword=$pass`nkeyAlias=pattool`nkeyPassword=$pass`n"
  [System.IO.File]::WriteAllText($props, $propsText, $utf8NoBom)
  Write-Host "Created release keystore. Back up android\pattool-release.keystore and android\keystore.properties (they are not in git)."
} elseif ((Test-Path $keystore) -ne (Test-Path $props)) {
  Write-Error "Release signing is incomplete: pattool-release.keystore and keystore.properties must both be present."
}

Push-Location $android
try {
  & .\gradlew.bat assembleRelease
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}

$apk = Join-Path $front "android\app\build\outputs\apk\release\app-release.apk"
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
