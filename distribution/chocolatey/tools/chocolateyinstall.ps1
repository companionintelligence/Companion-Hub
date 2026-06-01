$ErrorActionPreference = 'Stop'

$packageName  = 'companion-hub'
$toolsDir     = "$(Split-Path -parent $MyInvocation.MyCommand.Definition)"

$packageArgs = @{
  packageName   = $packageName
  fileType      = 'msi'
  url64bit      = 'https://github.com/companionintelligence/CI-Hub/releases/download/v0.2.4/Companion.Hub_0.2.4_x64_en-US.msi'
  checksum64    = 'PLACEHOLDER_SHA256_MSI'
  checksumType64= 'sha256'
  silentArgs    = '/quiet /norestart'
  validExitCodes= @(0, 3010)
}

Install-ChocolateyPackage @packageArgs

# Register deep-link protocol handler
$registryPath = 'HKLM:\SOFTWARE\Classes\cihub'
if (-not (Test-Path $registryPath)) {
    New-Item -Path $registryPath -Force | Out-Null
    New-ItemProperty -Path $registryPath -Name '(Default)' -Value 'URL:Companion Hub' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $registryPath -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null

    New-Item -Path "$registryPath\shell\open\command" -Force | Out-Null
    $exePath = "${env:ProgramFiles}\Companion Hub\Companion Hub.exe"
    New-ItemProperty -Path "$registryPath\shell\open\command" -Name '(Default)' `
        -Value "`"$exePath`" `"%1`"" -PropertyType String -Force | Out-Null
}