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
    # SilentlyContinue: when cleaning other users' profiles the existence check can hit
    # a locked-down AppData; stay quiet here (removal failures still log via WARN below).
    if (Test-Path $PathToDelete -ErrorAction SilentlyContinue) {
        try {
            Remove-Item -Path $PathToDelete -Recurse -Force -ErrorAction Stop
            Write-CleanupLog 'INFO' "Removed $PathToDelete"
        }
        catch {
            Write-CleanupLog 'WARN' "Failed to remove $PathToDelete"
        }
    }
}

# BEGIN hub tunnel folder cleanup
# The desktop keeps its Cloudflare tunnel token in a folder named `tunnel` beside its data
# folder (%APPDATA%\tunnel next to %APPDATA%\companion-hub; compose mounts
# ${ROOT_FOLDER_HOST}/../tunnel), not inside it, so removing the data folder leaves the
# token behind and a reinstall reconnects the old tunnel before it is paired. `tunnel` is a
# generic name another program could also use, so only what the Hub writes there is
# removed, and the folder only once it is empty. Mirrors the Linux uninstall scripts.

# True when the file decodes as a cloudflared tunnel token: base64 of a JSON object holding
# the account tag (a), tunnel id (t) and tunnel secret (s).
function Test-CloudflaredTunnelToken {
    param([string]$TokenPath)
    try {
        $item = Get-Item -LiteralPath $TokenPath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
        if ($item.Length -eq 0 -or $item.Length -gt 4096) { return $false }
        $encoded = [IO.File]::ReadAllText($item.FullName) -replace '\s', ''
        switch ($encoded.Length % 4) {
            2 { $encoded += '==' }
            3 { $encoded += '=' }
        }
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
        $parsed = $json | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $parsed) { return $false }
        $names = @($parsed.PSObject.Properties | ForEach-Object { $_.Name })
        foreach ($key in @('a', 't', 's')) {
            if ($names -cnotcontains $key) { return $false }
        }
        return $true
    }
    catch {
        return $false
    }
}

function Remove-HubTunnelFiles {
    param([string]$TunnelDir)
    try {
        $dir = Get-Item -LiteralPath $TunnelDir -Force -ErrorAction Stop
    }
    catch {
        return
    }
    # Runs over every profile: never follow a junction or symlinked folder.
    if (-not $dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }

    $toRemove = @()
    $tokenPath = Join-Path $dir.FullName 'token'
    if (Test-CloudflaredTunnelToken $tokenPath) { $toRemove += $tokenPath }

    # Marker files the backend writes beside the token: {"tunnelId": ..., "writtenAt"|"foundAt": ...}.
    foreach ($marker in @('registration.json', 'leftover.json')) {
        $markerPath = Join-Path $dir.FullName $marker
        try {
            $markerItem = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
            if (-not $markerItem.PSIsContainer -and -not ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
                ([IO.File]::ReadAllText($markerItem.FullName) -match '"tunnelId"')) {
                $toRemove += $markerPath
            }
        }
        catch { }
    }

    # Written by the desktop when the user clears the token from the tray.
    $clearedMarker = Join-Path $dir.FullName '.user-cleared-token'
    if (Test-Path -LiteralPath $clearedMarker -PathType Leaf -ErrorAction SilentlyContinue) { $toRemove += $clearedMarker }

    foreach ($path in $toRemove) {
        try {
            Remove-Item -LiteralPath $path -Force -ErrorAction Stop
            Write-CleanupLog 'INFO' "Removed $path"
        }
        catch {
            Write-CleanupLog 'WARN' "Failed to remove $path"
        }
    }

    # The backend creates certs\ empty; anything inside it belongs to something else.
    foreach ($emptyDir in @((Join-Path $dir.FullName 'certs'), $dir.FullName)) {
        try {
            $candidate = Get-Item -LiteralPath $emptyDir -Force -ErrorAction Stop
            if (-not $candidate.PSIsContainer -or ($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
            if (@(Get-ChildItem -LiteralPath $emptyDir -Force -ErrorAction Stop).Count -gt 0) { continue }
            Remove-Item -LiteralPath $emptyDir -Force -ErrorAction Stop
            Write-CleanupLog 'INFO' "Removed $emptyDir"
        }
        catch { }
    }
}
# END hub tunnel folder cleanup

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

# Collect the unique image IDs used by a compose project (pulled or built). Must be
# called before the project's containers are removed — refs can't be recovered after.
function Get-ProjectImageIds {
    param([string]$Project)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return @() }
    $ids = @()
    try {
        $containerIds = docker ps -a --filter "label=com.docker.compose.project=$Project" -q 2>$null
        foreach ($cid in $containerIds) { if ($cid) { $ids += docker inspect --format '{{.Image}}' $cid 2>$null } }
        $ids += docker images --filter "label=com.docker.compose.project=$Project" -q 2>$null
    }
    catch { }
    return $ids | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
}

# Marketplace apps run as their own compose projects (<app>_<store>), separate from
# the Hub stack. New apps carry `ci-hub.managed=true`; pre-rename apps carry
# `ci-os-hub.managed=true`. Discover the union, then remove each project's
# containers, networks (except the shared Hub networks), volumes, and images.
function Remove-MarketplaceApps {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return }

    $managedProjects = @()
    try {
        $managedProjects = @(
            docker ps -a --filter 'label=ci-hub.managed=true' --format '{{.Label "com.docker.compose.project"}}' 2>$null
            docker ps -a --filter 'label=ci-os-hub.managed=true' --format '{{.Label "com.docker.compose.project"}}' 2>$null
        ) |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    }
    catch {
        Write-CleanupLog 'WARN' 'Unable to enumerate managed marketplace app containers'
        return
    }

    foreach ($project in $managedProjects) {
        if ([string]::IsNullOrWhiteSpace($project)) { continue }
        # Defense-in-depth: only act on values matching Docker's compose-project charset
        # before interpolating them into Docker arguments.
        if ($project -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') { continue }
        # The Hub's own compose services also carry managed=true; the dedicated
        # Hub-stack cleanup below is the single source of truth, so skip it here.
        if ($project -in @('ci-os-hub', 'ci-hub')) { continue }

        $projectImages = Get-ProjectImageIds $project

        $containerIds = docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' 2>$null
        foreach ($cid in $containerIds) { if ($cid) { Invoke-CleanupCommand "docker rm -f $cid" } }

        $appNetworks = docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' 2>$null
        foreach ($net in $appNetworks) {
            if ($net -and $net -notin @('bridge', 'host', 'none', 'ci_hub_network', 'ci-hub_network', 'ci_os_hub_network', 'ci-os-hub_network')) {
                Invoke-CleanupCommand "docker network rm $net"
            }
        }

        $appVolumes = docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' 2>$null
        foreach ($vol in $appVolumes) { if ($vol) { Invoke-CleanupCommand "docker volume rm $vol" } }

        foreach ($img in $projectImages) { if ($img) { Invoke-CleanupCommand "docker image rm -f $img" } }
    }
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
    Remove-MarketplaceApps

    $hubImages = @(Get-ProjectImageIds 'ci-os-hub') + @(Get-ProjectImageIds 'ci-hub') |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

    $containerNames = @()
    $containerNames += Get-ContainerNamesByFilter 'label=com.docker.compose.project=ci-os-hub'
    $containerNames += Get-ContainerNamesByFilter 'label=com.docker.compose.project=ci-hub'
    $containerNames += Get-ContainerNamesByFilter 'network=ci_hub_network'
    $containerNames += Get-ContainerNamesByFilter 'network=ci-hub_network'
    $containerNames += Get-ContainerNamesByFilter 'network=ci_os_hub_network'
    $containerNames += Get-ContainerNamesByFilter 'network=ci-os-hub_network'

    $containerNames = $containerNames | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    foreach ($name in $containerNames) {
        Invoke-CleanupCommand "docker rm -f $name"
    }

    $networks = @('ci_hub_network', 'ci-hub_network', 'ci_os_hub_network', 'ci-os-hub_network')
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

    foreach ($img in $hubImages) { if ($img) { Invoke-CleanupCommand "docker image rm -f $img" } }
} else {
    Write-CleanupLog 'INFO' 'Docker is not available; skipping Docker cleanup'
}

$appData = [Environment]::GetFolderPath('ApplicationData')
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
# Mirror the Debian postrm name list exactly (note the lowercase 'ci-hub').
$stateNames = @('Companion Hub', 'companion-hub', 'ci-hub', 'CI-Hub', 'computer.ci.app.hub')

# Current user — GetFolderPath honors relocated/roaming AppData.
foreach ($name in $stateNames) {
    Remove-IfExists (Join-Path $appData $name)
    Remove-IfExists (Join-Path $localAppData $name)
}
# The desktop's data folder is %APPDATA%\companion-hub, so its tunnel folder is %APPDATA%\tunnel.
Remove-HubTunnelFiles (Join-Path $appData 'tunnel')

# All user profiles — parity with the Debian postrm, which cleans every user's home
# (root + uid>=1000), not just the one running the uninstall. Profile paths come from
# the registry (authoritative even when a profile is relocated). Other users' profiles
# are only reachable when the uninstaller runs elevated (per-machine installs), so this
# is best-effort; Remove-IfExists is idempotent, so re-touching the current user is a no-op.
$profilePaths = @()
try {
    $profilePaths = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -ErrorAction Stop |
        ForEach-Object { (Get-ItemProperty $_.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath } |
        # ProfileImagePath is REG_EXPAND_SZ and may hold unexpanded vars (e.g. %SystemDrive%);
        # expand before Test-Path so those profiles aren't silently skipped. No-op if already literal.
        ForEach-Object { if ($_) { [Environment]::ExpandEnvironmentVariables($_) } } |
        Where-Object { $_ -and (Test-Path $_ -ErrorAction SilentlyContinue) }
}
catch {
    Write-CleanupLog 'WARN' 'Unable to enumerate user profiles; cleaned current user only'
}

foreach ($profilePath in $profilePaths) {
    foreach ($name in $stateNames) {
        Remove-IfExists (Join-Path $profilePath "AppData\Roaming\$name")
        Remove-IfExists (Join-Path $profilePath "AppData\Local\$name")
    }
    Remove-HubTunnelFiles (Join-Path $profilePath 'AppData\Roaming\tunnel')
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
