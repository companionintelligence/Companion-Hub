$ErrorActionPreference = 'Continue'

function Write-CleanupLog {
    param(
        [string]$Level,
        [string]$Message
    )
    Write-Host "[cleanup][$Level] $Message"
}

function Invoke-CleanupCommand {
    param([string]$Command)
    try {
        Invoke-Expression $Command | Out-Null
        return $true
    }
    catch {
        Write-CleanupLog 'WARN' "Command failed: $Command"
        return $false
    }
}

function Remove-IfExists {
    param([string]$PathToDelete)
    if (Test-Path $PathToDelete) {
        try {
            Remove-Item -Path $PathToDelete -Recurse -Force
            Write-CleanupLog 'INFO' "Removed $PathToDelete"
        }
        catch {
            Write-CleanupLog 'WARN' "Failed to remove $PathToDelete"
        }
    }
}

function Get-ContainerNamesByFilter {
    param([string]$Filter)
    try {
        return docker ps -a --filter $Filter --format '{{.Names}}' 2>$null
    }
    catch {
        return @()
    }
}

$containerNames = @()
$containerNames += Get-ContainerNamesByFilter 'label=com.docker.compose.project=ci-os-hub'
$containerNames += Get-ContainerNamesByFilter 'label=com.docker.compose.project=ci-hub'
$containerNames += Get-ContainerNamesByFilter 'label=com.docker.compose.project=runtipi'
$containerNames += Get-ContainerNamesByFilter 'network=ci_os_hub_network'
$containerNames += Get-ContainerNamesByFilter 'network=ci-os-hub_network'

$containerNames = $containerNames | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
foreach ($name in $containerNames) {
    Invoke-CleanupCommand "docker rm -f $name"
}

$networks = @('ci_os_hub_network', 'ci-os-hub_network')
foreach ($network in $networks) {
    Invoke-CleanupCommand "docker network rm $network"
}

$volumes = @()
try {
    $volumes = docker volume ls --format '{{.Name}}' 2>$null
}
catch {
    Write-CleanupLog 'WARN' 'Unable to enumerate Docker volumes'
}

foreach ($volume in $volumes) {
    if ($volume -match 'ci_os_hub|ci-os-hub|runtipi|ci_hub_pgdata|^e2e-|^test-e2e-') {
        Invoke-CleanupCommand "docker volume rm $volume"
    }
}

$appData = [Environment]::GetFolderPath('ApplicationData')
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$stateNames = @('Companion Hub', 'companion-hub', 'CI-Hub', 'computer.ci.app.hub')

foreach ($name in $stateNames) {
    Remove-IfExists (Join-Path $appData $name)
    Remove-IfExists (Join-Path $localAppData $name)
}

$registryPath = 'HKLM:\SOFTWARE\Classes\cihub'
if (Test-Path $registryPath) {
    try {
        Remove-Item -Path $registryPath -Recurse -Force
        Write-CleanupLog 'INFO' 'Removed cihub protocol registry key'
    }
    catch {
        Write-CleanupLog 'WARN' 'Could not remove cihub protocol registry key'
    }
}

Write-CleanupLog 'INFO' 'Uninstall cleanup finished'
