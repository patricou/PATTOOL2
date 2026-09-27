#Requires -Version 5.1
<#
.SYNOPSIS
    Importe un certificat GoDaddy (feuille + chaine) dans un keystore Java existant.

.DESCRIPTION
    Le keystore doit deja contenir la PrivateKeyEntry generee avec le CSR.
    Le script importe root / cross / intermediate, puis le certificat du site.
    Si keytool n arrive pas a reconstruire la chaine, il importe un fullchain.pem.
    Produit le fichier final tomcat.keystore.jks (le JKS source du CSR n est pas ecrase).

.EXAMPLE
    cd "S:\patrick\Save_prg_OFFICIAL\Certificat SSL GoDaddy\2026_09_27"
    powershell -ExecutionPolicy Bypass -File C:\Dev\PATTOOL2\scripts\import-godaddy-keystore.ps1
#>
[CmdletBinding()]
param(
    [string]$CertDir = (Get-Location).Path,
    [string]$Keystore = 'mon_keystore.jks',
    [string]$OutKeystore = 'tomcat.keystore.jks',
    [string]$Alias = 'patrickdeschamps.com',
    [string]$Domain = 'patrickdeschamps.com',
    [string]$StorePass,
    [switch]$SkipPkcs12
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[!] $Message" -ForegroundColor Yellow
}

function Resolve-ExistingFile {
    param([string]$Directory, [string[]]$Candidates)
    foreach ($name in $Candidates) {
        $path = Join-Path $Directory $name
        if (Test-Path -LiteralPath $path) {
            return (Resolve-Path -LiteralPath $path).Path
        }
    }
    return $null
}

function Get-PemBlocks {
    param([string]$Path)
    $raw = [System.IO.File]::ReadAllText($Path)
    $pemMatches = [regex]::Matches($raw, '-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----')
    return @($pemMatches | ForEach-Object { $_.Value.Trim() })
}

function Write-FullChainPem {
    param([string[]]$InputFiles, [string]$OutputPath)
    $blocks = New-Object System.Collections.Generic.List[string]
    foreach ($file in $InputFiles) {
        if (-not $file -or -not (Test-Path -LiteralPath $file)) { continue }
        $found = Get-PemBlocks -Path $file
        if ($found.Count -eq 0) {
            $leafName = Split-Path $file -Leaf
            Write-Warn "Pas de bloc PEM dans $leafName - fichier ignore pour le fullchain."
            continue
        }
        foreach ($block in $found) {
            if (-not $blocks.Contains($block)) {
                [void]$blocks.Add($block)
            }
        }
    }
    if ($blocks.Count -eq 0) {
        throw 'Impossible de construire fullchain.pem (aucun certificat PEM).'
    }
    $text = ($blocks -join "`n") + "`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($OutputPath, $text, $utf8NoBom)
    return $blocks.Count
}

function ConvertTo-PlainText {
    param([System.Security.SecureString]$Secure)
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Invoke-Keytool {
    param(
        [Parameter(Mandatory)][string[]]$ToolArgs,
        [switch]$AllowFail
    )
    Write-Host ('    keytool ' + ($ToolArgs -join ' ')) -ForegroundColor DarkGray

    # keytool writes warnings (JKS format, etc.) to stderr. PowerShell turns that
    # into NativeCommandError when ErrorActionPreference is Stop.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & keytool @ToolArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($null -eq $code) { $code = 0 }

    $text = @(
        $raw | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() }
            else { "$_" }
        }
    ) -join "`n"
    $text = $text.Trim()
    if ($text) { Write-Host $text }
    if ($code -ne 0 -and -not $AllowFail) {
        throw "keytool a echoue (code $code)."
    }
    return [pscustomobject]@{ ExitCode = $code; Output = $text }
}

function Get-KeystoreEntryText {
    param([string]$KeystorePath, [string]$EntryAlias)
    $r = Invoke-Keytool -AllowFail -ToolArgs @(
        '-list', '-v',
        '-keystore', $KeystorePath,
        '-alias', $EntryAlias,
        '-storepass:env', 'STOREPASS'
    )
    return $r.Output
}

function Clear-StorePass {
    if ($script:cleaned) { return }
    $script:cleaned = $true
    Remove-Item Env:STOREPASS -ErrorAction SilentlyContinue
}

if (-not (Get-Command keytool -ErrorAction SilentlyContinue)) {
    throw 'keytool introuvable. Ajoute le JDK au PATH (bin\keytool.exe).'
}

$CertDir = (Resolve-Path -LiteralPath $CertDir).Path
if ([System.IO.Path]::IsPathRooted($Keystore)) {
    $sourceKeystore = $Keystore
} else {
    $sourceKeystore = Join-Path $CertDir $Keystore
}
if ([System.IO.Path]::IsPathRooted($OutKeystore)) {
    $outKeystorePath = $OutKeystore
} else {
    $outKeystorePath = Join-Path $CertDir $OutKeystore
}

if (-not (Test-Path -LiteralPath $sourceKeystore)) {
    throw "Keystore introuvable : $sourceKeystore. Le fichier doit contenir la cle privee du CSR."
}

$leafPem = Resolve-ExistingFile $CertDir @(
    ($Domain + '-certificate.pem'),
    ($Domain + '.pem')
)
$leafCrt = Resolve-ExistingFile $CertDir @(
    ($Domain + '-certificate.crt'),
    ($Domain + '.crt')
)
$leafFile = if ($leafPem) { $leafPem } else { $leafCrt }
$rootFile = Resolve-ExistingFile $CertDir @(($Domain + '-root.pem'), 'root.pem', 'gd_bundle-g2-g1.crt')
$intermediateFile = Resolve-ExistingFile $CertDir @(($Domain + '-intermediate.pem'), 'intermediate.pem', 'gdig2.crt')
$crossFile = Resolve-ExistingFile $CertDir @(($Domain + '-cross.pem'), 'cross.pem')

if (-not $leafFile) {
    throw "Certificat du site introuvable dans : $CertDir"
}

Write-Host 'Certificats GoDaddy vers keystore Java' -ForegroundColor White
Write-Host "Dossier      : $CertDir"
Write-Host "Source       : $sourceKeystore"
Write-Host "Sortie       : $outKeystorePath"
Write-Host "Alias cle    : $Alias"
Write-Host ('Site         : ' + (Split-Path $leafFile -Leaf))
if ($intermediateFile) { Write-Host ('Intermediaire: ' + (Split-Path $intermediateFile -Leaf)) }
if ($crossFile) { Write-Host ('Cross        : ' + (Split-Path $crossFile -Leaf)) }
if ($rootFile) { Write-Host ('Root         : ' + (Split-Path $rootFile -Leaf)) }

if (-not $StorePass) {
    $secure = Read-Host 'Mot de passe du keystore' -AsSecureString
    $StorePass = ConvertTo-PlainText -Secure $secure
}
if ([string]::IsNullOrWhiteSpace($StorePass)) {
    throw 'Mot de passe du keystore vide.'
}

$env:STOREPASS = $StorePass
$script:cleaned = $false
Register-EngineEvent PowerShell.Exiting -Action { Remove-Item Env:STOREPASS -ErrorAction SilentlyContinue } | Out-Null

try {
    Write-Step 'Contenu actuel du keystore source'
    $list = Invoke-Keytool -ToolArgs @(
        '-list',
        '-keystore', $sourceKeystore,
        '-storepass:env', 'STOREPASS'
    )
    if ($list.Output -notmatch [regex]::Escape($Alias)) {
        throw "Alias '$Alias' absent du keystore."
    }
    if ($list.Output -notmatch 'PrivateKeyEntry') {
        throw 'Aucune PrivateKeyEntry dans le keystore. Utilise le JKS du CSR, pas un keystore vide.'
    }

    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $backup = $null
    if (Test-Path -LiteralPath $outKeystorePath) {
        $backup = "$outKeystorePath.bak_$stamp"
        Copy-Item -LiteralPath $outKeystorePath -Destination $backup -Force
        Write-Ok "Sauvegarde de l ancien fichier de sortie : $backup"
    }

    Write-Step ('Copie vers ' + (Split-Path $outKeystorePath -Leaf))
    $sourceFull = [System.IO.Path]::GetFullPath($sourceKeystore)
    $outFull = [System.IO.Path]::GetFullPath($outKeystorePath)
    if ($sourceFull -ne $outFull) {
        Copy-Item -LiteralPath $sourceKeystore -Destination $outKeystorePath -Force
    }
    $keystorePath = $outKeystorePath
    Write-Ok "Travail sur : $keystorePath"

    $caImports = @(
        @{ Alias = 'godaddy-root'; File = $rootFile },
        @{ Alias = 'godaddy-cross'; File = $crossFile },
        @{ Alias = 'godaddy-intermediate'; File = $intermediateFile }
    )

    Write-Step 'Import de la chaine GoDaddy (trustedCertEntry)'
    foreach ($ca in $caImports) {
        if (-not $ca.File) { continue }
        Invoke-Keytool -AllowFail -ToolArgs @(
            '-delete',
            '-alias', $ca.Alias,
            '-keystore', $keystorePath,
            '-storepass:env', 'STOREPASS'
        ) | Out-Null
        Invoke-Keytool -ToolArgs @(
            '-importcert',
            '-noprompt',
            '-trustcacerts',
            '-alias', $ca.Alias,
            '-file', $ca.File,
            '-keystore', $keystorePath,
            '-storepass:env', 'STOREPASS'
        )
        Write-Ok ('Importe ' + $ca.Alias + ' depuis ' + (Split-Path $ca.File -Leaf))
    }

    $fullchainPath = Join-Path $CertDir 'fullchain.pem'
    $chainInputs = @($leafFile, $intermediateFile, $crossFile, $rootFile)
    $blockCount = Write-FullChainPem -InputFiles $chainInputs -OutputPath $fullchainPath
    Write-Ok ('fullchain.pem (' + $blockCount + ' certificats) : ' + $fullchainPath)

    Write-Step "Import du certificat du site (alias $Alias)"
    $reply = Invoke-Keytool -AllowFail -ToolArgs @(
        '-importcert',
        '-noprompt',
        '-trustcacerts',
        '-alias', $Alias,
        '-file', $leafFile,
        '-keystore', $keystorePath,
        '-storepass:env', 'STOREPASS',
        '-keypass:env', 'STOREPASS'
    )

    if ($reply.ExitCode -ne 0 -or $reply.Output -match 'Failed to establish chain') {
        Write-Warn 'Import du certificat seul impossible. Nouvel essai avec fullchain.pem.'
        $reply = Invoke-Keytool -ToolArgs @(
            '-importcert',
            '-noprompt',
            '-trustcacerts',
            '-alias', $Alias,
            '-file', $fullchainPath,
            '-keystore', $keystorePath,
            '-storepass:env', 'STOREPASS',
            '-keypass:env', 'STOREPASS'
        )
    }
    Write-Ok "Reponse CA installee sur l alias $Alias"

    Write-Step 'Verification de la chaine'
    $detail = Get-KeystoreEntryText -KeystorePath $keystorePath -EntryAlias $Alias
    if ($detail -notmatch 'PrivateKeyEntry') {
        throw "L alias $Alias n est plus une PrivateKeyEntry."
    }

    $chainLen = 0
    if ($detail -match 'Certificate chain length: (\d+)') {
        $chainLen = [int]$Matches[1]
    }
    if ($chainLen -lt 2) {
        throw ('Chaine trop courte (longueur=' + $chainLen + '). keytool n a pas rattache l intermediaire GoDaddy.')
    }
    Write-Ok "Certificate chain length: $chainLen"

    $p12Path = $null
    if (-not $SkipPkcs12) {
        Write-Step 'Export PKCS12 (recommande pour Spring Boot / Java 21)'
        $p12Path = [System.IO.Path]::ChangeExtension($keystorePath, '.p12')
        if (Test-Path -LiteralPath $p12Path) {
            Copy-Item -LiteralPath $p12Path -Destination "$p12Path.bak_$stamp" -Force
            Remove-Item -LiteralPath $p12Path -Force
        }
        Invoke-Keytool -ToolArgs @(
            '-importkeystore',
            '-srckeystore', $keystorePath,
            '-srcstoretype', 'JKS',
            '-destkeystore', $p12Path,
            '-deststoretype', 'PKCS12',
            '-srcalias', $Alias,
            '-destalias', $Alias,
            '-srcstorepass:env', 'STOREPASS',
            '-deststorepass:env', 'STOREPASS',
            '-srckeypass:env', 'STOREPASS',
            '-noprompt'
        )
        Write-Ok "PKCS12 : $p12Path"
    }

    Write-Host ''
    Write-Host 'Keystore pret.' -ForegroundColor Green
    Write-Host "JKS     : $outKeystorePath"
    if ($p12Path) { Write-Host "PKCS12  : $p12Path" }
    if ($backup) { Write-Host "Backup  : $backup" }
    Write-Host "Source  : $sourceKeystore (non modifie)"
    Write-Host ''
    Write-Host 'application.properties :' -ForegroundColor Cyan
    Write-Host "server.ssl.key-store=$outKeystorePath"
    Write-Host 'server.ssl.key-store-type=JKS'
    Write-Host 'server.ssl.key-store-password=<ton mot de passe>'
    Write-Host "server.ssl.keyAlias=$Alias"
    Write-Host ''
    Write-Host 'Redemarre ensuite Tomcat / le JAR Spring.'
}
finally {
    Clear-StorePass
}
