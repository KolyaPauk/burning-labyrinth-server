# Prepares a clean Windows machine to run the Burning Labyrinth server:
#  1. downloads a portable Node.js into .\runtime (only if a suitable Node is not installed) - no admin rights needed
#  2. opens the TCP port in Windows Firewall (asks for admin rights via UAC)
# The server itself has no npm dependencies, so nothing else is installed.
param(
    [int]$Port = 3000,
    [switch]$FirewallOnly
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $root 'runtime'
$ruleName = 'Burning Labyrinth Server'
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NodeVersion($exe) {
    try { return [version](& $exe -p 'process.versions.node') } catch { return $null }
}

# node:sqlite is unflagged only since Node 22.13 / 23.4, so check the capability itself rather than the version.
function Test-Node($exe) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $exe -e "require('node:sqlite')" *> $null; return ($LASTEXITCODE -eq 0) }
    catch { return $false }
    finally { $ErrorActionPreference = $old }
}

function Test-Firewall {
    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if (-not $rule) { return $false }
    return [bool]($rule | Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -eq "$Port" -and $_.Protocol -eq 'TCP' })
}

function Install-Firewall {
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
    Write-Host "Firewall: inbound TCP $Port allowed."
}

if ($FirewallOnly) {
    Install-Firewall
    exit 0
}

# --- Node.js ---
$localNode = Join-Path $runtime 'node.exe'
$sysNode = Get-Command node -ErrorAction SilentlyContinue

if ((Test-Path $localNode) -and (Test-Node $localNode)) {
    Write-Host "Using bundled Node.js $(Get-NodeVersion $localNode)"
} elseif ($sysNode -and (Test-Node $sysNode.Source)) {
    Write-Host "Using installed Node.js $(Get-NodeVersion $sysNode.Source)"
} else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
    $base = 'https://nodejs.org/dist/latest-v24.x'
    Write-Host "Suitable Node.js (with node:sqlite, 22.13+/23.4+/24+) not found. Downloading portable Node.js ($arch)..."
    $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
    $line = $sums | Where-Object { $_ -match "node-v[\d.]+-$arch\.zip\s*$" } | Select-Object -First 1
    if (-not $line) { throw 'Could not find Node.js package in the nodejs.org listing.' }
    $hash, $file = $line.Trim() -split '\s+'

    $zip = Join-Path $env:TEMP $file
    Invoke-WebRequest "$base/$file" -OutFile $zip -UseBasicParsing
    if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $hash.ToUpper()) { throw 'Node.js download checksum mismatch.' }

    $tmp = Join-Path $env:TEMP ('node-extract-' + [guid]::NewGuid())
    Expand-Archive $zip -DestinationPath $tmp
    if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
    Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $runtime
    Remove-Item $tmp, $zip -Recurse -Force
    if (-not (Test-Node $localNode)) { throw 'Downloaded Node.js does not support node:sqlite.' }
    Write-Host "Node.js $(Get-NodeVersion $localNode) installed to $runtime"
}

# --- Firewall (needs admin) ---
if (Test-Firewall) {
    Write-Host "Firewall: inbound TCP $Port already allowed."
} elseif (Test-Admin) {
    Install-Firewall
} else {
    Write-Host 'Requesting administrator rights to open the firewall port (you can decline, then open it manually)...'
    try {
        Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port $Port -FirewallOnly"
    } catch {
        Write-Warning "Firewall rule was not created. Other devices may not reach the server on port $Port."
    }
}

Write-Host ''
Write-Host 'Done. Start the server with start.bat. Use one of these addresses in UE (ServerUrl):'
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
    ForEach-Object { Write-Host "  http://$($_.IPAddress):$Port" }
