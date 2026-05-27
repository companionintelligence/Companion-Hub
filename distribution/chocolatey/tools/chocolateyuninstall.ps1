$ErrorActionPreference = 'Stop'

$packageName = 'companion-hub'

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

# Remove deep-link registry keys
$registryPath = 'HKLM:\SOFTWARE\Classes\cihub'
if (Test-Path $registryPath) {
    Remove-Item -Path $registryPath -Recurse -Force
}