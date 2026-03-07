# ===================================================================
# PATTOOL Build and Deploy Script
# ===================================================================
# 1. Build front end (Angular)
# 2. Build back end with Maven (clean, compile, package)
# 3. Copy JAR to X:\pattool (network drive mapped to server)
#
# Stop and start PATTOOL on the server (PAT-DESKTOP) manually.
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
# Step 1: Build front end
# ---------------------------------------------------------------------------
Write-Host "[1/3] Building front end..." -ForegroundColor Yellow
if (-not (Test-Path $FrontEndDir)) {
    Write-Host "ERROR: Front end directory not found: $FrontEndDir" -ForegroundColor Red
    exit 1
}
Push-Location $FrontEndDir
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Front end build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
Write-Host "Front end build completed." -ForegroundColor Green
Write-Host ""

# ---------------------------------------------------------------------------
# Step 2: Build back end with Maven
# ---------------------------------------------------------------------------
Write-Host "[2/3] Building back end (Maven clean, compile, package)..." -ForegroundColor Yellow
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
Write-Host "[3/3] Copying JAR to $DeployDir..." -ForegroundColor Yellow
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
