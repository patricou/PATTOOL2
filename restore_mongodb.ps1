# MongoDB Restore Script
# This script restores the MongoDB backup from the specified path
#
# INSTRUCTIONS:
# 1. Make sure MongoDB Database Tools are installed (mongorestore)
# 2. Usually located at: C:\Program Files\MongoDB\Tools\100\bin\mongorestore.exe
# 3. Add MongoDB Tools to your PATH, or use the full path below
# 4. Update the connectionString if your MongoDB is not on localhost:27017
# 5. Update targetDatabase if you want a different database name

$backupPath = "S:\patrick\Save_prg_OFFICIAL\MongoDB\rando20251123-2\rando2"
$targetDatabase = "rando2"  # Change this if you want to restore to a different database name
$connectionString = "mongodb+srv://patricou:xxxxx@rando.ieagq.mongodb.net/"  # MongoDB Atlas connection string - REPLACE xxxxx with your actual password

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
Write-Host ""

# Restore the database
& $mongorestorePath --uri "$connectionString" --db "$targetDatabase" --drop "$backupPath"

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nRestore completed successfully!" -ForegroundColor Green
} else {
    Write-Host "`nRestore failed with error code: $LASTEXITCODE" -ForegroundColor Red
}

