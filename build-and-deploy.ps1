# ===================================================================
# PATTOOL Build and Deploy Script
# ===================================================================
# 1. Stamp the About-page version
# 2. In parallel: Android APK (mobile Angular build + Gradle) and the production web build.
#    They write to different folders (www vs the backend static tree) and do not share a Webpack cache.
# 3. Copy the new APK into the web assets after the web build, so that build cannot overwrite it
# 4. Maven clean package — only after those assets are final, because the JAR embeds them
# 5. Copy JAR to X:\pattool (network drive mapped to server)
#
# The About page reads PatTool_Front-End/src/environments/app-version.ts.
# Each run stamps APP_VERSION = yyyy.MM.dd.HHmmss before the APK and the web build
# (the APK compiles that file via build:mobile), then restores 'dev'.
#
# Stop and start PATTOOL on the server (PAT-DESKTOP) manually.
# After restart, Outils → Application Android serves /assets/downloads/pattool.apk
# ===================================================================
#
# If Maven is not found, set your Maven install folder here (path to the
# folder that contains bin\mvn.cmd), then run the script again:
#
$MavenHome = ""   # e.g. "C:\Program Files\Apache\maven" or "C:\tools\apache-maven-3.9.6"
#
# Java 21 is required to build the back end. Set this if the build fails with "invalid target release: 21":
#
$JavaHome = "C:\Program Files\Java\jdk-21"   # folder that contains bin\java.exe
if (-not (Test-Path "$JavaHome\bin\java.exe")) {
    $corretto = "C:\Program Files\Amazon Corretto\jdk21.0.13_0"
    if (Test-Path "$corretto\bin\java.exe") { $JavaHome = $corretto }
}
#
# ===================================================================

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$FrontEndDir = Join-Path $ProjectRoot "PatTool_Front-End"
$BackEndDir = Join-Path $ProjectRoot "PatTool_Back-End"
$JarSource = Join-Path $BackEndDir "target\pattool-0.0.1-SNAPSHOT.jar"
$DeployDir = "X:\pattool"

# Resolve Maven command (mvn not always in PATH in PowerShell)
$MvnCmd = $null
if ($MavenHome -and (Test-Path "$MavenHome\bin\mvn.cmd")) {
    $MvnCmd = "$MavenHome\bin\mvn.cmd"
} elseif (Get-Command mvn -ErrorAction SilentlyContinue) {
    $MvnCmd = "mvn"
} elseif ($env:MAVEN_HOME -and (Test-Path "$env:MAVEN_HOME\bin\mvn.cmd")) {
    $MvnCmd = "$env:MAVEN_HOME\bin\mvn.cmd"
} elseif ($env:M2_HOME -and (Test-Path "$env:M2_HOME\bin\mvn.cmd")) {
    $MvnCmd = "$env:M2_HOME\bin\mvn.cmd"
} else {
    $commonPaths = @(
        "C:\Program Files\JetBrains\IntelliJ IDEA 2024.1\plugins\maven\lib\maven3\bin\mvn.cmd",
        "C:\Program Files\Apache\maven\bin\mvn.cmd",
        "C:\Program Files (x86)\Apache\maven\bin\mvn.cmd",
        "C:\apache-maven\bin\mvn.cmd",
        "C:\maven\bin\mvn.cmd",
        "C:\tools\apache-maven\bin\mvn.cmd",
        "C:\tools\maven\bin\mvn.cmd"
    )
    foreach ($p in $commonPaths) {
        if (Test-Path $p) { $MvnCmd = $p; break }
    }
    if (-not $MvnCmd) {
        $jetbrains = "C:\Program Files\JetBrains"
        if (Test-Path $jetbrains) {
            $ideaMaven = Get-ChildItem -Path $jetbrains -Filter "IntelliJ IDEA*" -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName "plugins\maven\lib\maven3\bin\mvn.cmd" } |
                Where-Object { Test-Path $_ } |
                Select-Object -First 1
            if ($ideaMaven) { $MvnCmd = $ideaMaven }
        }
    }
    if (-not $MvnCmd) {
        $searchDirs = @($env:USERPROFILE, "C:\tools", "C:\dev")
        foreach ($dir in $searchDirs) {
            if (-not (Test-Path $dir)) { continue }
            $mavenDir = Get-ChildItem -Path $dir -Filter "apache-maven*" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($mavenDir -and (Test-Path "$($mavenDir.FullName)\bin\mvn.cmd")) {
                $MvnCmd = "$($mavenDir.FullName)\bin\mvn.cmd"
                break
            }
        }
    }
}
if (-not $MvnCmd) {
    Write-Host "ERROR: Maven not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "Do one of the following:" -ForegroundColor Yellow
    Write-Host "  1. Edit build-and-deploy.ps1 and set MavenHome at the top to your Maven folder (the one that contains bin\mvn.cmd)." -ForegroundColor White
    Write-Host "  2. Set MAVEN_HOME before running:  `$env:MAVEN_HOME = 'C:\path\to\maven'" -ForegroundColor White
    Write-Host "  3. Add Maven's bin folder to your system PATH." -ForegroundColor White
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  PATTOOL Build and Deploy" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# Stamp the About version before the APK and the web build share it
# ---------------------------------------------------------------------------
if (-not (Test-Path $FrontEndDir)) {
    Write-Host "ERROR: Front end directory not found: $FrontEndDir" -ForegroundColor Red
    exit 1
}
$AppVersionFile = Join-Path $FrontEndDir "src\environments\app-version.ts"
if (-not (Test-Path $AppVersionFile)) {
    Write-Host "ERROR: Version file not found: $AppVersionFile" -ForegroundColor Red
    exit 1
}
$OriginalVersionBytes = [System.IO.File]::ReadAllBytes($AppVersionFile)
$DeployVersion = Get-Date -Format "yyyy.MM.dd.HHmmss"
Write-Host "About version: $DeployVersion" -ForegroundColor Gray
$utf8 = New-Object System.Text.UTF8Encoding $false
$stamped = @"
/**
 * Stamped by build-and-deploy.ps1 for this deployment.
 */
export const APP_VERSION = '$DeployVersion';
"@
[System.IO.File]::WriteAllText($AppVersionFile, ($stamped.Trim() + "`n"), $utf8)

try {
    # -----------------------------------------------------------------------
    # Step 1: APK and web build at the same time. The APK is not copied into
    # the web tree yet: ng build wipes that tree and would put the old APK back.
    # -----------------------------------------------------------------------
    Write-Host "[1/4] Building Android APK and web front end in parallel..." -ForegroundColor Yellow
    $apkScript = Join-Path $FrontEndDir "scripts\build-android-apk.ps1"
    $logDir = Join-Path $env:TEMP "pattool-deploy"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $apkLog = Join-Path $logDir "apk.log"
    $webLog = Join-Path $logDir "web.log"
    $runners = @(
        @{
            Name = "apk"
            Bat = Join-Path $logDir "apk.cmd"
            Log = $apkLog
            Body = "@echo off`r`ncd /d `"$FrontEndDir`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$apkScript`" -Stage build > `"$apkLog`" 2>&1`r`nexit /b %ERRORLEVEL%`r`n"
        },
        @{
            Name = "web"
            Bat = Join-Path $logDir "web.cmd"
            Log = $webLog
            Body = "@echo off`r`ncd /d `"$FrontEndDir`"`r`ncall npm.cmd run build > `"$webLog`" 2>&1`r`nexit /b %ERRORLEVEL%`r`n"
        }
    )
    $running = @()
    foreach ($runner in $runners) {
        [System.IO.File]::WriteAllText($runner.Bat, $runner.Body)
        Remove-Item $runner.Log -ErrorAction SilentlyContinue
        # cmd.exe owns the log file. Do not also redirect from Start-Process.
        $proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/c", "`"$($runner.Bat)`"") -WorkingDirectory $FrontEndDir -PassThru -WindowStyle Hidden
        $running += [pscustomobject]@{
            Name = $runner.Name
            Process = $proc
            Log = $runner.Log
            Started = Get-Date
        }
        Write-Host ("  started {0}" -f $runner.Name) -ForegroundColor Gray
    }

    while ($true) {
        foreach ($job in $running) {
            $job.Process.Refresh()
            if ($job.Process.HasExited) { $null = $job.Process.WaitForExit() }
        }
        $alive = @($running | Where-Object { -not $_.Process.HasExited })
        $justFailed = @($running | Where-Object { $_.Process.HasExited -and $_.Process.ExitCode -ne 0 })
        if ($justFailed.Count -gt 0) {
            foreach ($job in $alive) {
                & taskkill.exe /PID $job.Process.Id /T /F 2>$null | Out-Null
            }
            Start-Sleep -Seconds 1
            foreach ($job in $running) {
                $job.Process.Refresh()
                if ($job.Process.HasExited) { $null = $job.Process.WaitForExit() }
            }
            break
        }
        if ($alive.Count -eq 0) { break }
        foreach ($job in $alive) {
            $line = ""
            if (Test-Path $job.Log) {
                $line = (Get-Content $job.Log -Tail 1 -ErrorAction SilentlyContinue)
            }
            $stamp = ([int]((Get-Date) - $job.Started).TotalSeconds).ToString() + "s"
            if ($line) {
                Write-Host ("  [{0} {1}] {2}" -f $job.Name, $stamp, $line)
            } else {
                Write-Host ("  [{0} {1}] running" -f $job.Name, $stamp) -ForegroundColor Gray
            }
        }
        Start-Sleep -Seconds 15
    }

    $failed = $false
    foreach ($job in $running) {
        if (-not $job.Process.HasExited) { $null = $job.Process.WaitForExit() }
        $elapsed = (Get-Date) - $job.Started
        $code = $job.Process.ExitCode
        if ($code -ne 0) {
            $failed = $true
            Write-Host ("{0} failed (exit {1}) after {2:mm\:ss}" -f $job.Name, $code, $elapsed) -ForegroundColor Red
            if (Test-Path $job.Log) {
                Write-Host ("--- {0} ---" -f $job.Log) -ForegroundColor Red
                Get-Content $job.Log -Tail 40
            }
        } else {
            Write-Host ("{0} finished in {1:mm\:ss}" -f $job.Name, $elapsed) -ForegroundColor Green
        }
    }
    if ($failed) { throw "Parallel front-end build failed." }

    # -----------------------------------------------------------------------
    # Step 2: the web build has finished writing static/. Drop the new APK in.
    # -----------------------------------------------------------------------
    Write-Host "[2/4] Publishing Android APK into the site..." -ForegroundColor Yellow
    & powershell -NoProfile -ExecutionPolicy Bypass -File $apkScript -Stage publish
    if ($LASTEXITCODE -ne 0) { throw "APK publish failed with exit code $LASTEXITCODE" }
    Write-Host "Front end and APK ready (version $DeployVersion)." -ForegroundColor Green
    Write-Host ""
} finally {
    [System.IO.File]::WriteAllBytes($AppVersionFile, $OriginalVersionBytes)
}

# ---------------------------------------------------------------------------
# Step 2: Build back end with Maven
# ---------------------------------------------------------------------------
Write-Host "[3/4] Building back end (Maven clean, compile, package)..." -ForegroundColor Yellow
if (-not (Test-Path $BackEndDir)) {
    Write-Host "ERROR: Back end directory not found: $BackEndDir" -ForegroundColor Red
    exit 1
}
if ($JavaHome -and (Test-Path "$JavaHome\bin\java.exe")) {
    $env:JAVA_HOME = $JavaHome
    Write-Host "  Using Java: $JavaHome" -ForegroundColor Gray
}
Push-Location $BackEndDir
try {
    & $MvnCmd clean compile package
    if ($LASTEXITCODE -ne 0) { throw "Maven build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
if (-not (Test-Path $JarSource)) {
    Write-Host "ERROR: JAR not found after build: $JarSource" -ForegroundColor Red
    exit 1
}
Write-Host "Back end build completed." -ForegroundColor Green
Write-Host ""

# ---------------------------------------------------------------------------
# Step 3: Copy JAR to X:\pattool (mapped drive to server)
# ---------------------------------------------------------------------------
Write-Host "[4/4] Copying JAR to $DeployDir..." -ForegroundColor Yellow
if (-not (Test-Path $DeployDir)) {
    Write-Host "ERROR: Deploy directory not found: $DeployDir. Ensure drive X: is mapped." -ForegroundColor Red
    exit 1
}
Copy-Item -Path $JarSource -Destination $DeployDir -Force
Write-Host "JAR copied successfully." -ForegroundColor Green
Write-Host ""
Write-Host "Stop and start PATTOOL on the server manually when ready." -ForegroundColor Gray
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Build and deploy completed." -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""
