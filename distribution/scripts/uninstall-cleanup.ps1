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
            Remove-Item -Path $PathToDelete -Recurse -Force -ErrorAction Stop
            Write-CleanupLog 'INFO' "Removed $PathToDelete"
        }
        catch {
            Write-CleanupLog 'WARN' "Failed to remove $PathToDelete"
        }
    }
}

function Get-ContainerNamesByFilter {
    param([string]$Filter)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        return @()
    }
    try {
        return docker ps -a --filter $Filter --format '{{.Names}}' 2>$null
    }
    catch {
        return @()
    }
}

# Marketplace apps run as their own compose projects (<app>_<store>), separate from
# the Hub stack. Hub stamps every managed app container with `ci-os-hub.managed=true`
# (store-agnostic). Discover the project set from those containers, then remove each
# project's containers, networks (except the shared Hub network), and volumes.
function Remove-MarketplaceApps {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return }

    $managedProjects = @()
    try {
        $managedProjects = docker ps -a --filter 'label=ci-os-hub.managed=true' --format '{{.Label "com.docker.compose.project"}}' 2>$null |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    }
    catch {
        Write-CleanupLog 'WARN' 'Unable to enumerate managed marketplace app containers'
        return
    }

    foreach ($project in $managedProjects) {
        if ([string]::IsNullOrWhiteSpace($project)) { continue }

        $containerIds = docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' 2>$null
        foreach ($cid in $containerIds) { if ($cid) { Invoke-CleanupCommand "docker rm -f $cid" } }

        $appNetworks = docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' 2>$null
        foreach ($net in $appNetworks) {
            if ($net -and $net -notin @('bridge', 'host', 'none', 'ci_os_hub_network', 'ci-os-hub_network')) {
                Invoke-CleanupCommand "docker network rm $net"
            }
        }

        $appVolumes = docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' 2>$null
        foreach ($vol in $appVolumes) { if ($vol) { Invoke-CleanupCommand "docker volume rm $vol" } }
    }
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
    Remove-MarketplaceApps

    $containerNames = @()
    $containerNames += Get-ContainerNamesByFilter 'label=com.docker.compose.project=ci-os-hub'
    $containerNames += Get-ContainerNamesByFilter 'label=com.docker.compose.project=ci-hub'
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
        if ($volume -match 'ci_os_hub|ci-os-hub|ci_hub_pgdata|ci_hub_app_data|hub_tailscale_state') {
            Invoke-CleanupCommand "docker volume rm $volume"
        }
    }
} else {
    Write-CleanupLog 'INFO' 'Docker is not available; skipping Docker cleanup'
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
        Remove-Item -Path $registryPath -Recurse -Force -ErrorAction Stop
        Write-CleanupLog 'INFO' 'Removed cihub protocol registry key'
    }
    catch {
        Write-CleanupLog 'WARN' 'Could not remove cihub protocol registry key'
    }
}

Write-CleanupLog 'INFO' 'Uninstall cleanup finished'
