#Requires -Version 5.1
<#
.SYNOPSIS
    Installe PATTOOL comme application Windows (fenetre Edge sans barre d'adresse).

.DESCRIPTION
    Cree une icone .ico a partir de pat.png, puis deux raccourcis PATTOOL :
    Bureau et menu Demarrer. La cible est Microsoft Edge en mode application
    vers https://www.patrickdeschamps.com (session Edge deja utilisee).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File C:\dev\PATTOOL2\scripts\install-pattool-windows.ps1
#>
[CmdletBinding()]
param(
    [string]$PngPath,
    [string]$AppUrl = 'https://www.patrickdeschamps.com'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $PngPath) {
    $PngPath = Join-Path $RepoRoot 'PatTool_Front-End\src\assets\images\pat.png'
}

function Write-Step {
    param([string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Get-EdgePath {
    $cmd = Get-Command msedge.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) {
        return $cmd.Source
    }

    $regCandidates = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'
    )
    foreach ($key in $regCandidates) {
        $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        if ($props.'(default)' -and (Test-Path -LiteralPath $props.'(default)')) {
            return $props.'(default)'
        }
    }

    $files = @(
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($file in $files) {
        if ($file -and (Test-Path -LiteralPath $file)) {
            return $file
        }
    }

    throw "Microsoft Edge est introuvable. Installez Edge, puis relancez ce script."
}

function Save-PngAsIco {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePng,
        [Parameter(Mandatory = $true)][string]$DestinationIco
    )

    Add-Type -AssemblyName System.Drawing

    $sizes = @(16, 32, 48, 256)
    $pngBlobs = New-Object System.Collections.Generic.List[byte[]]
    $src = [System.Drawing.Image]::FromFile($SourcePng)
    try {
        foreach ($size in $sizes) {
            $bmp = New-Object System.Drawing.Bitmap $size, $size
            $graphics = [System.Drawing.Graphics]::FromImage($bmp)
            try {
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $graphics.Clear([System.Drawing.Color]::Transparent)
                $graphics.DrawImage($src, 0, 0, $size, $size)
            } finally {
                $graphics.Dispose()
            }

            $stream = New-Object System.IO.MemoryStream
            try {
                $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                $pngBlobs.Add($stream.ToArray())
            } finally {
                $stream.Dispose()
                $bmp.Dispose()
            }
        }
    } finally {
        $src.Dispose()
    }

    $headerSize = 6
    $entrySize = 16
    $offset = $headerSize + ($entrySize * $pngBlobs.Count)
    $directory = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter $directory
    try {
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]$pngBlobs.Count)

        for ($i = 0; $i -lt $pngBlobs.Count; $i++) {
            $dim = $sizes[$i]
            $widthByte = if ($dim -ge 256) { [byte]0 } else { [byte]$dim }
            $writer.Write($widthByte)
            $writer.Write($widthByte)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]$pngBlobs[$i].Length)
            $writer.Write([uint32]$offset)
            $offset += $pngBlobs[$i].Length
        }
        $writer.Flush()

        $out = [System.IO.File]::Create($DestinationIco)
        try {
            $directory.Position = 0
            $directory.CopyTo($out)
            foreach ($blob in $pngBlobs) {
                $out.Write($blob, 0, $blob.Length)
            }
        } finally {
            $out.Dispose()
        }
    } finally {
        $writer.Dispose()
    }
}

function New-PatToolShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$EdgePath,
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$IconPath
    )

    $folder = Split-Path -Parent $ShortcutPath
    if (-not (Test-Path -LiteralPath $folder)) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
    }

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $EdgePath
    $shortcut.Arguments = "--app=$Url"
    $shortcut.WorkingDirectory = Split-Path -Parent $EdgePath
    $shortcut.WindowStyle = 1
    $shortcut.Description = 'PATTOOL'
    $shortcut.IconLocation = "$IconPath,0"
    $shortcut.Save()
}

Write-Step "Recherche de Microsoft Edge"
$edge = Get-EdgePath
Write-Ok $edge

if (-not (Test-Path -LiteralPath $PngPath)) {
    throw "Icone source introuvable : $PngPath"
}

$installDir = Join-Path $env:LOCALAPPDATA 'PATTOOL'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
$icoPath = Join-Path $installDir 'pattool.ico'

Write-Step "Creation de l'icone"
Save-PngAsIco -SourcePng $PngPath -DestinationIco $icoPath
Write-Ok $icoPath

$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$shortcuts = @(
    (Join-Path $desktop 'PATTOOL.lnk'),
    (Join-Path $programs 'PATTOOL.lnk')
)

Write-Step "Raccourcis Bureau et menu Demarrer"
foreach ($shortcutPath in $shortcuts) {
    New-PatToolShortcut -ShortcutPath $shortcutPath -EdgePath $edge -Url $AppUrl -IconPath $icoPath
    Write-Ok $shortcutPath
}

Write-Host ''
Write-Host "PATTOOL est installe. Ouvrez le raccourci Bureau ou cherchez PATTOOL dans le menu Demarrer." -ForegroundColor Green
