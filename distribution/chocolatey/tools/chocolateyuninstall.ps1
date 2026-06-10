$ErrorActionPreference = 'Stop'

$packageName = 'companion-hub'
$toolsDir = "$(Split-Path -parent $MyInvocation.MyCommand.Definition)"

# Uninstall the MSI package
$softwareName = 'Companion Hub*'
[array]$installed = Get-UninstallRegistryKey -SoftwareName $softwareName

if ($installed.Count -eq 1) {
    $installed | ForEach-Object {
        if ($_.UninstallString -match 'msiexec') {
            Uninstall-ChocolateyPackage `
                -PackageName $packageName `
                -FileType 'msi' `
                -SilentArgs "/quiet /norestart" `
                -File "$($_.UninstallString -replace 'MsiExec.exe /[XI]','' -replace '{|}','' )" `
                -ValidExitCodes @(0, 3010)
        } else {
            Uninstall-ChocolateyPackage `
                -PackageName $packageName `
                -FileType 'exe' `
                -SilentArgs '/S' `
                -File $_.UninstallString `
                -ValidExitCodes @(0)
        }
    }
} elseif ($installed.Count -eq 0) {
    Write-Warning "'$packageName' is not installed via Add/Remove Programs."
} else {
    Write-Warning "Multiple '$packageName' installs found; uninstall manually."
}

# Run comprehensive uninstall cleanup (best effort).
$cleanupScript = Join-Path $toolsDir 'scripts\uninstall-cleanup.ps1'
if (Test-Path $cleanupScript) {
    try {
        & $cleanupScript
    }
    catch {
        Write-Warning "Extended cleanup failed: $($_.Exception.Message)"
    }
} else {
    Write-Warning 'Cleanup script not found; skipping extended cleanup.'
}