$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $projectRoot '.local/desktop-build/tools'
New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
$innoSetup = Join-Path $toolsRoot 'innosetup-7.0.2-x64.exe'
$innoCompiler = Join-Path $toolsRoot 'inno/ISCC.exe'

function Get-VerifiedDownload([string]$Url, [string]$Destination, [string]$Publisher) {
    if (-not (Test-Path -LiteralPath $Destination)) {
        Invoke-WebRequest -Uri $Url -OutFile $Destination
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Destination
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch $Publisher) {
        throw "Publisher verification failed: $Destination"
    }
}

Get-VerifiedDownload 'https://github.com/jrsoftware/issrc/releases/download/is-7_0_2/innosetup-7.0.2-x64.exe' $innoSetup 'Pyrsys'
if (-not (Test-Path -LiteralPath $innoCompiler)) {
    $destination = Join-Path $toolsRoot 'inno'
    $process = Start-Process -FilePath $innoSetup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/PORTABLE=1', ('/DIR="' + $destination + '"')) -WindowStyle Hidden -PassThru
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw 'Inno Setup preparation failed.' }
}
Get-VerifiedDownload 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' (Join-Path $toolsRoot 'MicrosoftEdgeWebview2Setup.exe') 'Microsoft'
Write-Output "Desktop build tools ready: $innoCompiler"
