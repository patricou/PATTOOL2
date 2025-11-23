# MongoDB Restore Script with Secure Password Input
# This script restores the MongoDB backup from the specified path

$backupPath = "S:\patrick\Save_prg_OFFICIAL\MongoDB\rando20251123-2\rando2"
$targetDatabase = "rando2"  # Change this if you want to restore to a different database name
$username = "patricou"
$cluster = "rando.ieagq.mongodb.net"

# Prompt for password securely
$securePassword = Read-Host "Enter your MongoDB password" -AsSecureString
$password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
)
$connectionString = "mongodb+srv://${username}:${password}@${cluster}/"

# Set mongorestore path
$mongorestorePath = "C:\MongoDB\mongodb-database-tools-windows-x86_64-100.13.0\bin\mongorestore.exe"

# Verify mongorestore exists
if (-not (Test-Path $mongorestorePath)) {
    Write-Host "ERROR: mongorestore not found at: $mongorestorePath" -ForegroundColor Red
    Write-Host "Please verify the path is correct." -ForegroundColor Yellow
    exit 1
}

Write-Host "Using mongorestore at: $mongorestorePath" -ForegroundColor Green
Write-Host "Starting MongoDB restore..." -ForegroundColor Green
Write-Host "Backup path: $backupPath" -ForegroundColor Yellow
Write-Host "Target database: $targetDatabase" -ForegroundColor Yellow
Write-Host "Cluster: $cluster" -ForegroundColor Yellow
Write-Host ""

# Restore the database
& $mongorestorePath --uri "$connectionString" --db "$targetDatabase" --drop "$backupPath"

# Clear password from memory
$password = $null

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nRestore completed successfully!" -ForegroundColor Green
} else {
    Write-Host "`nRestore failed with error code: $LASTEXITCODE" -ForegroundColor Red
}

