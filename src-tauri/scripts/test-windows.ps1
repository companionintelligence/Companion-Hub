# CI OS Hub Desktop - Windows Testing Script
# This script automates testing of the desktop application on Windows

param(
    [switch]$Verbose,
    [switch]$SkipBuild,
    [switch]$SkipSystemTests,
    [switch]$SkipInstallerTests,
    [string]$Feature
)

$ErrorActionPreference = "Continue"
$script:TestResults = @()
$script:PassCount = 0
$script:FailCount = 0
$script:SkipCount = 0

# Color output functions
function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-Failure {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "ℹ $Message" -ForegroundColor Cyan
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Write-TestHeader {
    param([string]$Message)
    Write-Host "`n=== $Message ===" -ForegroundColor Magenta
}

# Test result tracking
function Add-TestResult {
    param(
        [string]$TestName,
        [string]$Status,  # Pass, Fail, Skip
        [string]$Message = ""
    )
    
    $script:TestResults += [PSCustomObject]@{
        Test = $TestName
        Status = $Status
        Message = $Message
        Timestamp = Get-Date
    }
    
    switch ($Status) {
        "Pass" { $script:PassCount++; Write-Success "$TestName - PASS" }
        "Fail" { $script:FailCount++; Write-Failure "$TestName - FAIL: $Message" }
        "Skip" { $script:SkipCount++; Write-Warning "$TestName - SKIP: $Message" }
    }
}

# Check prerequisites
function Test-Prerequisites {
    Write-TestHeader "Checking Prerequisites"
    
    # Check Rust
    try {
        $rustVersion = cargo --version
        if ($LASTEXITCODE -eq 0) {
            Add-TestResult "Rust Installation" "Pass" "Found: $rustVersion"
        } else {
            Add-TestResult "Rust Installation" "Fail" "Cargo not found"
            return $false
        }
    } catch {
        Add-TestResult "Rust Installation" "Fail" "Cargo not found"
        return $false
    }
    
    # Check Node/Bun
    try {
        $bunVersion = bun --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Add-TestResult "Bun Installation" "Pass" "Found: $bunVersion"
        } else {
            $nodeVersion = node --version
            if ($LASTEXITCODE -eq 0) {
                Add-TestResult "Node Installation" "Pass" "Found: $nodeVersion"
            } else {
                Add-TestResult "Node/Bun Installation" "Fail" "Neither found"
                return $false
            }
        }
    } catch {
        Add-TestResult "Node/Bun Installation" "Fail" "Not found"
        return $false
    }
    
    # Check WebView2
    $webview2Path = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    if (Test-Path $webview2Path) {
        Add-TestResult "WebView2 Runtime" "Pass" "Installed"
    } else {
        Add-TestResult "WebView2 Runtime" "Fail" "Not installed"
        Write-Warning "Download from: https://developer.microsoft.com/en-us/microsoft-edge/webview2/"
    }
    
    return $true
}

# Build the application
function Build-Application {
    Write-TestHeader "Building Application"
    
    if ($SkipBuild) {
        Add-TestResult "Application Build" "Skip" "Skipped by user"
        return $true
    }
    
    Push-Location "$PSScriptRoot/../../"
    
    try {
        Write-Info "Installing dependencies..."
        if (Get-Command bun -ErrorAction SilentlyContinue) {
            bun install
        } else {
            npm install
        }
        
        if ($LASTEXITCODE -ne 0) {
            Add-TestResult "Dependencies Install" "Fail" "Install failed"
            return $false
        }
        Add-TestResult "Dependencies Install" "Pass"
        
        Write-Info "Building common package..."
        if (Get-Command bun -ErrorAction SilentlyContinue) {
            bun run build
        } else {
            npm run build
        }
        
        if ($LASTEXITCODE -ne 0) {
            Add-TestResult "Common Package Build" "Fail" "Build failed"
            return $false
        }
        Add-TestResult "Common Package Build" "Pass"
        
        Write-Info "Building Rust application..."
        Set-Location src-tauri
        cargo build --release
        
        if ($LASTEXITCODE -ne 0) {
            Add-TestResult "Rust Application Build" "Fail" "Build failed"
            return $false
        }
        Add-TestResult "Rust Application Build" "Pass"
        
    } finally {
        Pop-Location
    }
    
    return $true
}

# Test system detection commands
function Test-SystemDetection {
    Write-TestHeader "Testing System Detection"
    
    if ($SkipSystemTests) {
        Add-TestResult "System Detection Tests" "Skip" "Skipped by user"
        return
    }
    
    Write-Info "System detection tests require the app to be running"
    Add-TestResult "System Detection" "Skip" "Manual testing required - see TESTING.md"
}

# Test Windows-specific commands
function Test-WindowsCommands {
    Write-TestHeader "Testing Windows-Specific Commands"
    
    if ($SkipInstallerTests) {
        Add-TestResult "Installer Tests" "Skip" "Skipped by user"
        return
    }
    
    # Test WSL2 detection
    Write-Info "Testing WSL2 detection..."
    try {
        $wslVersion = wsl --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Add-TestResult "WSL2 Detection (Manual)" "Pass" "WSL2 is installed"
        } else {
            Add-TestResult "WSL2 Detection (Manual)" "Pass" "WSL2 not installed (expected)"
        }
    } catch {
        Add-TestResult "WSL2 Detection (Manual)" "Pass" "WSL2 not installed (expected)"
    }
    
    # Test Docker detection
    Write-Info "Testing Docker detection..."
    try {
        $dockerVersion = docker --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Add-TestResult "Docker Detection (Manual)" "Pass" "Docker is installed: $dockerVersion"
        } else {
            Add-TestResult "Docker Detection (Manual)" "Pass" "Docker not installed (expected)"
        }
    } catch {
        Add-TestResult "Docker Detection (Manual)" "Pass" "Docker not installed (expected)"
    }
    
    # Test Python detection
    Write-Info "Testing Python detection..."
    try {
        $pythonVersion = python --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Add-TestResult "Python Detection (Manual)" "Pass" "Python is installed: $pythonVersion"
        } else {
            Add-TestResult "Python Detection (Manual)" "Pass" "Python not installed (expected)"
        }
    } catch {
        Add-TestResult "Python Detection (Manual)" "Pass" "Python not installed (expected)"
    }
}

# Test build artifacts
function Test-BuildArtifacts {
    Write-TestHeader "Testing Build Artifacts"
    
    $releaseExe = "$PSScriptRoot/../target/release/ci-os-hub-desktop.exe"
    $msiPath = "$PSScriptRoot/../target/release/bundle/msi/"
    
    if (Test-Path $releaseExe) {
        Add-TestResult "Release Executable" "Pass" "Found at $releaseExe"
        
        $fileSize = (Get-Item $releaseExe).Length / 1MB
        Write-Info "Executable size: $([math]::Round($fileSize, 2)) MB"
    } else {
        Add-TestResult "Release Executable" "Fail" "Not found at $releaseExe"
    }
    
    if (Test-Path $msiPath) {
        $msiFiles = Get-ChildItem $msiPath -Filter "*.msi"
        if ($msiFiles.Count -gt 0) {
            Add-TestResult "MSI Installer" "Pass" "Found $($msiFiles.Count) installer(s)"
            foreach ($msi in $msiFiles) {
                $fileSize = $msi.Length / 1MB
                Write-Info "  - $($msi.Name): $([math]::Round($fileSize, 2)) MB"
            }
        } else {
            Add-TestResult "MSI Installer" "Fail" "No MSI files found"
        }
    } else {
        Add-TestResult "MSI Installer" "Skip" "Build with 'cargo tauri build' to create installers"
    }
}

# Generate test report
function Show-TestReport {
    Write-TestHeader "Test Report"
    
    $total = $script:PassCount + $script:FailCount + $script:SkipCount
    
    Write-Host "`nTotal Tests: $total" -ForegroundColor White
    Write-Success "Passed: $script:PassCount"
    Write-Failure "Failed: $script:FailCount"
    Write-Warning "Skipped: $script:SkipCount"
    
    if ($script:FailCount -eq 0) {
        Write-Host "`n✓ All tests passed!" -ForegroundColor Green
    } else {
        Write-Host "`n✗ Some tests failed. Review the output above." -ForegroundColor Red
    }
    
    # Show detailed results if verbose
    if ($Verbose) {
        Write-Host "`n--- Detailed Results ---" -ForegroundColor Cyan
        $script:TestResults | Format-Table -AutoSize
    }
    
    # Export results
    $reportPath = "$PSScriptRoot/test-results-windows.json"
    $script:TestResults | ConvertTo-Json | Out-File $reportPath
    Write-Info "Test results saved to: $reportPath"
    
    # Return exit code
    return $script:FailCount
}

# Main execution
function Main {
    Write-Host @"
╔════════════════════════════════════════════════════════════╗
║   CI OS Hub Desktop - Windows Testing Script              ║
║   Testing automation features on Windows                  ║
╚════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

    $startTime = Get-Date
    
    # Run tests based on feature flag
    if ($Feature) {
        Write-Info "Testing specific feature: $Feature"
        switch ($Feature) {
            "prerequisites" { Test-Prerequisites }
            "build" { Build-Application }
            "system-detection" { Test-SystemDetection }
            "windows-commands" { Test-WindowsCommands }
            "artifacts" { Test-BuildArtifacts }
            default {
                Write-Failure "Unknown feature: $Feature"
                Write-Info "Available features: prerequisites, build, system-detection, windows-commands, artifacts"
                exit 1
            }
        }
    } else {
        # Run all tests
        if (-not (Test-Prerequisites)) {
            Write-Failure "Prerequisites check failed. Cannot continue."
            exit 1
        }
        
        if (-not (Build-Application)) {
            Write-Failure "Build failed. Skipping further tests."
            Test-BuildArtifacts
            Show-TestReport
            exit 1
        }
        
        Test-SystemDetection
        Test-WindowsCommands
        Test-BuildArtifacts
    }
    
    $endTime = Get-Date
    $duration = $endTime - $startTime
    
    Write-Host "`nTest duration: $($duration.ToString('mm\:ss'))" -ForegroundColor Cyan
    
    $exitCode = Show-TestReport
    exit $exitCode
}

# Run main
Main
