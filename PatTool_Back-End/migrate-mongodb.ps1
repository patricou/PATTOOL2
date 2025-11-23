# MongoDB Migration Script
# Migrates data from MongoDB v4 (port 27017) to MongoDB 8.2 (port 27018)
# 
# Prerequisites:
# - MongoDB Database Tools must be installed at C:\MongoDB\mongodb-database-tools-windows-x86_64-100.13.0
# - Both MongoDB instances must be running
# - Network access to 192.168.1.33

param(
    [string]$SourceHost = "192.168.1.33",
    [int]$SourcePort = 27017,
    [string]$TargetHost = "192.168.1.33",
    [int]$TargetPort = 27018,
    [string]$Database = "rando",
    [string]$BackupDir = ".\mongodb-backup",
    [string]$MongoToolsPath = "C:\MongoDB\mongodb-database-tools-windows-x86_64-100.13.0"
)

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "MongoDB Migration Script" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Source: $SourceHost`:$SourcePort/$Database" -ForegroundColor Yellow
Write-Host "Target: $TargetHost`:$TargetPort/$Database" -ForegroundColor Yellow
Write-Host "MongoDB Tools: $MongoToolsPath" -ForegroundColor Yellow
Write-Host ""

# Set MongoDB tools paths
$mongodumpPath = Join-Path $MongoToolsPath "bin\mongodump.exe"
$mongorestorePath = Join-Path $MongoToolsPath "bin\mongorestore.exe"

# Check if mongodump is available
if (Test-Path $mongodumpPath) {
    Write-Host "[OK] mongodump found at: $mongodumpPath" -ForegroundColor Green
} else {
    Write-Host "[ERROR] mongodump not found at: $mongodumpPath" -ForegroundColor Red
    Write-Host "Please verify the MongoDB Database Tools path is correct." -ForegroundColor Yellow
    exit 1
}

# Check if mongorestore is available
if (Test-Path $mongorestorePath) {
    Write-Host "[OK] mongorestore found at: $mongorestorePath" -ForegroundColor Green
} else {
    Write-Host "[ERROR] mongorestore not found at: $mongorestorePath" -ForegroundColor Red
    Write-Host "Please verify the MongoDB Database Tools path is correct." -ForegroundColor Yellow
    exit 1
}

# Create backup directory
if (Test-Path $BackupDir) {
    Write-Host "[INFO] Backup directory exists: $BackupDir" -ForegroundColor Yellow
    $response = Read-Host "Do you want to remove existing backup? (y/N)"
    if ($response -eq "y" -or $response -eq "Y") {
        Remove-Item -Path $BackupDir -Recurse -Force
        Write-Host "[OK] Removed existing backup directory" -ForegroundColor Green
    } else {
        Write-Host "[INFO] Using existing backup directory" -ForegroundColor Yellow
    }
} else {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    Write-Host "[OK] Created backup directory: $BackupDir" -ForegroundColor Green
}

# Step 1: Dump data from source MongoDB
Write-Host ""
Write-Host "Step 1: Dumping data from MongoDB v4..." -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan

$dumpArgs = @(
    "--host", $SourceHost,
    "--port", $SourcePort.ToString(),
    "--db", $Database,
    "--out", $BackupDir
)
Write-Host "Executing: $mongodumpPath --host $SourceHost --port $SourcePort --db $Database --out `"$BackupDir`"" -ForegroundColor Gray

try {
    & $mongodumpPath $dumpArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Data dump completed successfully" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] Data dump failed with exit code $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[ERROR] Failed to execute mongodump: $_" -ForegroundColor Red
    exit 1
}

# Step 2: Verify dump
$dumpPath = Join-Path $BackupDir $Database
if (-not (Test-Path $dumpPath)) {
    Write-Host "[ERROR] Dump directory not found: $dumpPath" -ForegroundColor Red
    exit 1
}

$collections = Get-ChildItem -Path $dumpPath -Filter "*.bson" | Select-Object -ExpandProperty Name
Write-Host "[INFO] Found $($collections.Count) collections in dump" -ForegroundColor Yellow
foreach ($collection in $collections) {
    Write-Host "  - $collection" -ForegroundColor Gray
}

# Step 3: Restore data to target MongoDB
Write-Host ""
Write-Host "Step 2: Restoring data to MongoDB 8.2..." -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan

$restoreArgs = @(
    "--host", $TargetHost,
    "--port", $TargetPort.ToString(),
    "--db", $Database,
    "--drop",
    $dumpPath
)
Write-Host "Executing: $mongorestorePath --host $TargetHost --port $TargetPort --db $Database --drop `"$dumpPath`"" -ForegroundColor Gray
Write-Host "[WARNING] This will DROP existing data in the target database!" -ForegroundColor Yellow
$response = Read-Host "Continue? (y/N)"
if ($response -ne "y" -and $response -ne "Y") {
    Write-Host "[INFO] Migration cancelled by user" -ForegroundColor Yellow
    exit 0
}

try {
    & $mongorestorePath $restoreArgs
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Data restore completed successfully" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] Data restore failed with exit code $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[ERROR] Failed to execute mongorestore: $_" -ForegroundColor Red
    exit 1
}

# Step 4: Verification
Write-Host ""
Write-Host "Step 3: Verifying migration..." -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan

$verifyCommand = "mongo --host $TargetHost --port $TargetPort --eval `"db.getCollectionNames()`" $Database --quiet"
Write-Host "Checking collections in target database..." -ForegroundColor Gray

try {
    $result = Invoke-Expression $verifyCommand 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[OK] Migration verification successful" -ForegroundColor Green
        Write-Host "Collections in target database:" -ForegroundColor Yellow
        Write-Host $result -ForegroundColor Gray
    } else {
        Write-Host "[WARNING] Could not verify migration (mongo shell may not be available)" -ForegroundColor Yellow
        Write-Host "Please verify manually by connecting to MongoDB 8.2" -ForegroundColor Yellow
    }
} catch {
    Write-Host "[WARNING] Verification command failed (mongo shell may not be available)" -ForegroundColor Yellow
    Write-Host "Please verify manually by connecting to MongoDB 8.2" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Migration completed!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Verify data in MongoDB 8.2 (port 27018)" -ForegroundColor White
Write-Host "2. Update application.properties to use port 27018" -ForegroundColor White
Write-Host "3. Test the application with the new MongoDB instance" -ForegroundColor White
Write-Host "4. Once verified, you can stop MongoDB v4" -ForegroundColor White
Write-Host ""
Write-Host "Backup location: $BackupDir" -ForegroundColor Gray

