# Tests open-data sources used by the Electricity page (no Maven required).
$ErrorActionPreference = "Stop"

function Test-Url {
    param([string]$Name, [string]$Url)
    try {
        $r = Invoke-RestMethod -Uri $Url -TimeoutSec 30
        Write-Host "[OK] $Name" -ForegroundColor Green
        return $r
    } catch {
        Write-Host "[FAIL] $Name — $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

Write-Host "=== Electricity open-data smoke tests ===" -ForegroundColor Cyan

$odre = Test-Url "ODRÉ éCO2mix (France generation)" `
    'https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/eco2mix-national-tr/records?where=nucleaire%20is%20not%20null&order_by=date_heure%20DESC&limit=1'
if ($odre.results) {
    Write-Host "  Latest nuclear MW: $($odre.results[0].nucleaire) at $($odre.results[0].date_heure)"
}

$edfPlants = Test-Url "EDF nuclear plants" `
    "https://opendata.edf.fr/data-fair/api/v1/datasets/centrales-de-production-nucleaire-edf/lines?size=3"
if ($edfPlants.results) {
    Write-Host "  Plants sample: $($edfPlants.results[0].tranche)"
}

$edfUnavail = Test-Url "EDF REMIT unavailabilities (active nuclear)" `
    'https://opendata.edf.fr/data-fair/api/v1/datasets/indisponibilites-des-moyens-de-production-edf-sa/lines?filiere=Nucl%C3%A9aire&status=Active&size=5'
if ($edfUnavail.total -ne $null) {
    Write-Host "  Active nuclear unavail total: $($edfUnavail.total)"
}

$world = Test-Url "GeoNuclearData JSON" `
    "https://raw.githubusercontent.com/cristianst85/GeoNuclearData/master/data/json/denormalized/nuclear_power_plants.json"
if ($world -is [array]) {
    $op = ($world | Where-Object { $_.Status -eq 'Operational' }).Count
    Write-Host "  World plants: $($world.Count) (operational: $op)"
}

Write-Host ""
Write-Host "Backend PatTool endpoints (after mvn compile + restart):" -ForegroundColor Cyan
$base = "http://localhost:8000/api/external/electricity"
@("overview", "fr/plants", "fr/generation?hours=24", "fr/unavailabilities?active=true", "world/nuclear-plants") | ForEach-Object {
    try {
        $code = (Invoke-WebRequest -Uri "$base/$_" -UseBasicParsing -TimeoutSec 10).StatusCode
        Write-Host "[OK] GET /$_ — HTTP $code" -ForegroundColor Green
    } catch {
        $status = $_.Exception.Response.StatusCode.value__
        Write-Host "[—] GET /$_ — HTTP $status (rebuild backend if 401/404)" -ForegroundColor Yellow
    }
}
