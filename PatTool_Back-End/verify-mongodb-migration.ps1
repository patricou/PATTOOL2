# MongoDB Migration Verification Script
# Verifies that data was successfully migrated to MongoDB 8.2

param(
    [string]$Host = "192.168.1.33",
    [int]$Port = 27018,
    [string]$Database = "rando"
)

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "MongoDB Migration Verification" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Checking: $Host`:$Port/$Database" -ForegroundColor Yellow
Write-Host ""

# Try to connect using mongosh (MongoDB Shell 6.0+)
$mongoshAvailable = $false
try {
    $null = Get-Command mongosh -ErrorAction Stop
    $mongoshAvailable = $true
    Write-Host "[OK] mongosh found" -ForegroundColor Green
} catch {
    Write-Host "[INFO] mongosh not found, trying mongo..." -ForegroundColor Yellow
}

# Try to connect using mongo (legacy shell)
$mongoAvailable = $false
if (-not $mongoshAvailable) {
    try {
        $null = Get-Command mongo -ErrorAction Stop
        $mongoAvailable = $true
        Write-Host "[OK] mongo found" -ForegroundColor Green
    } catch {
        Write-Host "[WARNING] Neither mongosh nor mongo found in PATH" -ForegroundColor Yellow
        Write-Host "Please install MongoDB Shell to verify the migration" -ForegroundColor Yellow
        Write-Host "Download from: https://www.mongodb.com/try/download/shell" -ForegroundColor Yellow
    }
}

if ($mongoshAvailable) {
    Write-Host ""
    Write-Host "Checking collections..." -ForegroundColor Cyan
    $collectionsCommand = "mongosh --host $Host --port $Port --eval `"db.getCollectionNames()`" $Database --quiet"
    
    try {
        $collections = Invoke-Expression $collectionsCommand 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Successfully connected to MongoDB 8.2" -ForegroundColor Green
            Write-Host ""
            Write-Host "Collections found:" -ForegroundColor Yellow
            $collections | ForEach-Object {
                if ($_ -match '^\s*"([^"]+)"') {
                    Write-Host "  - $($matches[1])" -ForegroundColor White
                }
            }
            
            Write-Host ""
            Write-Host "Checking document counts..." -ForegroundColor Cyan
            $countCommand = "mongosh --host $Host --port $Port --eval `"db.getCollectionNames().forEach(c => print(c + ': ' + db.getCollection(c).countDocuments()))`" $Database --quiet"
            $counts = Invoke-Expression $countCommand 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host $counts -ForegroundColor Gray
            }
        } else {
            Write-Host "[ERROR] Failed to connect to MongoDB" -ForegroundColor Red
            Write-Host $collections -ForegroundColor Red
        }
    } catch {
        Write-Host "[ERROR] Failed to execute verification: $_" -ForegroundColor Red
    }
} elseif ($mongoAvailable) {
    Write-Host ""
    Write-Host "Checking collections..." -ForegroundColor Cyan
    $collectionsCommand = "mongo --host $Host --port $Port --eval `"db.getCollectionNames()`" $Database --quiet"
    
    try {
        $collections = Invoke-Expression $collectionsCommand 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[OK] Successfully connected to MongoDB 8.2" -ForegroundColor Green
            Write-Host ""
            Write-Host "Collections found:" -ForegroundColor Yellow
            $collections | ForEach-Object {
                if ($_ -match '^\s*"([^"]+)"') {
                    Write-Host "  - $($matches[1])" -ForegroundColor White
                }
            }
        } else {
            Write-Host "[ERROR] Failed to connect to MongoDB" -ForegroundColor Red
            Write-Host $collections -ForegroundColor Red
        }
    } catch {
        Write-Host "[ERROR] Failed to execute verification: $_" -ForegroundColor Red
    }
} else {
    Write-Host ""
    Write-Host "[INFO] Manual verification required" -ForegroundColor Yellow
    Write-Host "Connect to MongoDB using:" -ForegroundColor White
    Write-Host "  mongosh mongodb://$Host`:$Port/$Database" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Then run:" -ForegroundColor White
    Write-Host "  show collections" -ForegroundColor Gray
    Write-Host "  db.getCollectionNames().forEach(c => print(c + ': ' + db.getCollection(c).countDocuments()))" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan

