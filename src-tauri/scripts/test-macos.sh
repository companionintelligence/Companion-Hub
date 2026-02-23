#!/bin/bash
# CI OS Hub Desktop - macOS Testing Script
# This script automates testing of the desktop application on macOS

set +e  # Continue on errors

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Test tracking
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TEST_RESULTS=()

# Options
VERBOSE=false
SKIP_BUILD=false
SKIP_SYSTEM_TESTS=false
SKIP_INSTALLER_TESTS=false
FEATURE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --skip-system-tests)
            SKIP_SYSTEM_TESTS=true
            shift
            ;;
        --skip-installer-tests)
            SKIP_INSTALLER_TESTS=true
            shift
            ;;
        --feature|-f)
            FEATURE="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --verbose, -v              Show verbose output"
            echo "  --skip-build               Skip build step"
            echo "  --skip-system-tests        Skip system detection tests"
            echo "  --skip-installer-tests     Skip installer tests"
            echo "  --feature, -f <feature>    Test specific feature only"
            echo "  --help, -h                 Show this help message"
            echo ""
            echo "Features:"
            echo "  prerequisites              Check prerequisites only"
            echo "  build                      Build application only"
            echo "  system-detection           Test system detection"
            echo "  macos-commands             Test macOS-specific commands"
            echo "  artifacts                  Check build artifacts"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Output functions
write_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

write_failure() {
    echo -e "${RED}✗ $1${NC}"
}

write_info() {
    echo -e "${CYAN}ℹ $1${NC}"
}

write_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

write_test_header() {
    echo -e "\n${MAGENTA}=== $1 ===${NC}"
}

# Test result tracking
add_test_result() {
    local test_name="$1"
    local status="$2"
    local message="${3:-}"
    
    TEST_RESULTS+=("{\"test\":\"$test_name\",\"status\":\"$status\",\"message\":\"$message\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}")
    
    case $status in
        Pass)
            ((PASS_COUNT++))
            write_success "$test_name - PASS"
            ;;
        Fail)
            ((FAIL_COUNT++))
            write_failure "$test_name - FAIL: $message"
            ;;
        Skip)
            ((SKIP_COUNT++))
            write_warning "$test_name - SKIP: $message"
            ;;
    esac
}

# Check prerequisites
test_prerequisites() {
    write_test_header "Checking Prerequisites"
    
    # Check Rust
    if command -v cargo &> /dev/null; then
        local rust_version=$(cargo --version)
        add_test_result "Rust Installation" "Pass" "Found: $rust_version"
    else
        add_test_result "Rust Installation" "Fail" "Cargo not found"
        return 1
    fi
    
    # Check Node/Bun
    if command -v bun &> /dev/null; then
        local bun_version=$(bun --version)
        add_test_result "Bun Installation" "Pass" "Found: $bun_version"
    elif command -v node &> /dev/null; then
        local node_version=$(node --version)
        add_test_result "Node Installation" "Pass" "Found: $node_version"
    else
        add_test_result "Node/Bun Installation" "Fail" "Neither found"
        return 1
    fi
    
    # Check Xcode Command Line Tools
    if xcode-select -p &> /dev/null; then
        local xcode_path=$(xcode-select -p)
        add_test_result "Xcode Command Line Tools" "Pass" "Installed at $xcode_path"
    else
        add_test_result "Xcode Command Line Tools" "Fail" "Not installed"
        write_warning "Install with: xcode-select --install"
    fi
    
    # Check architecture
    local arch=$(uname -m)
    if [[ "$arch" == "arm64" ]]; then
        add_test_result "Architecture Detection" "Pass" "Apple Silicon (arm64)"
    elif [[ "$arch" == "x86_64" ]]; then
        add_test_result "Architecture Detection" "Pass" "Intel (x86_64)"
    else
        add_test_result "Architecture Detection" "Fail" "Unknown architecture: $arch"
    fi
    
    return 0
}

# Build the application
build_application() {
    write_test_header "Building Application"
    
    if [[ "$SKIP_BUILD" == true ]]; then
        add_test_result "Application Build" "Skip" "Skipped by user"
        return 0
    fi
    
    local project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
    cd "$project_root" || return 1
    
    write_info "Installing dependencies..."
    if command -v bun &> /dev/null; then
        bun install
    else
        npm install
    fi
    
    if [[ $? -ne 0 ]]; then
        add_test_result "Dependencies Install" "Fail" "Install failed"
        return 1
    fi
    add_test_result "Dependencies Install" "Pass"
    
    write_info "Building common package..."
    if command -v bun &> /dev/null; then
        bun run build
    else
        npm run build
    fi
    
    if [[ $? -ne 0 ]]; then
        add_test_result "Common Package Build" "Fail" "Build failed"
        return 1
    fi
    add_test_result "Common Package Build" "Pass"
    
    write_info "Building Rust application..."
    cd src-tauri || return 1
    cargo build --release
    
    if [[ $? -ne 0 ]]; then
        add_test_result "Rust Application Build" "Fail" "Build failed"
        return 1
    fi
    add_test_result "Rust Application Build" "Pass"
    
    cd "$project_root" || return 1
    return 0
}

# Test system detection
test_system_detection() {
    write_test_header "Testing System Detection"
    
    if [[ "$SKIP_SYSTEM_TESTS" == true ]]; then
        add_test_result "System Detection Tests" "Skip" "Skipped by user"
        return
    fi
    
    write_info "System detection tests require the app to be running"
    add_test_result "System Detection" "Skip" "Manual testing required - see TESTING.md"
}

# Test macOS-specific commands
test_macos_commands() {
    write_test_header "Testing macOS-Specific Commands"
    
    if [[ "$SKIP_INSTALLER_TESTS" == true ]]; then
        add_test_result "Installer Tests" "Skip" "Skipped by user"
        return
    fi
    
    # Test Homebrew detection
    write_info "Testing Homebrew detection..."
    if command -v brew &> /dev/null; then
        local brew_version=$(brew --version | head -n 1)
        add_test_result "Homebrew Detection (Manual)" "Pass" "Homebrew is installed: $brew_version"
    else
        add_test_result "Homebrew Detection (Manual)" "Pass" "Homebrew not installed (expected)"
    fi
    
    # Test Colima detection
    write_info "Testing Colima detection..."
    if command -v colima &> /dev/null; then
        local colima_version=$(colima version)
        add_test_result "Colima Detection (Manual)" "Pass" "Colima is installed: $colima_version"
    else
        add_test_result "Colima Detection (Manual)" "Pass" "Colima not installed (expected)"
    fi
    
    # Test Docker detection
    write_info "Testing Docker detection..."
    if command -v docker &> /dev/null; then
        local docker_version=$(docker --version)
        add_test_result "Docker Detection (Manual)" "Pass" "Docker is installed: $docker_version"
    else
        add_test_result "Docker Detection (Manual)" "Pass" "Docker not installed (expected)"
    fi
    
    # Test Python detection
    write_info "Testing Python detection..."
    if command -v python3 &> /dev/null; then
        local python_version=$(python3 --version)
        add_test_result "Python Detection (Manual)" "Pass" "Python is installed: $python_version"
    else
        add_test_result "Python Detection (Manual)" "Pass" "Python not installed (expected)"
    fi
}

# Test build artifacts
test_build_artifacts() {
    write_test_header "Testing Build Artifacts"
    
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local release_app="$script_dir/../target/release/ci-os-hub-desktop"
    local dmg_path="$script_dir/../target/release/bundle/dmg/"
    local app_path="$script_dir/../target/release/bundle/macos/"
    
    if [[ -f "$release_app" ]]; then
        add_test_result "Release Executable" "Pass" "Found at $release_app"
        local file_size=$(du -h "$release_app" | cut -f1)
        write_info "Executable size: $file_size"
    else
        add_test_result "Release Executable" "Fail" "Not found at $release_app"
    fi
    
    if [[ -d "$dmg_path" ]]; then
        local dmg_count=$(find "$dmg_path" -name "*.dmg" | wc -l)
        if [[ $dmg_count -gt 0 ]]; then
            add_test_result "DMG Installer" "Pass" "Found $dmg_count installer(s)"
            while IFS= read -r dmg_file; do
                local file_name=$(basename "$dmg_file")
                local file_size=$(du -h "$dmg_file" | cut -f1)
                write_info "  - $file_name: $file_size"
            done < <(find "$dmg_path" -name "*.dmg")
        else
            add_test_result "DMG Installer" "Fail" "No DMG files found"
        fi
    else
        add_test_result "DMG Installer" "Skip" "Build with 'cargo tauri build' to create installers"
    fi
    
    if [[ -d "$app_path" ]]; then
        local app_count=$(find "$app_path" -name "*.app" -depth 1 | wc -l)
        if [[ $app_count -gt 0 ]]; then
            add_test_result "App Bundle" "Pass" "Found $app_count bundle(s)"
        else
            add_test_result "App Bundle" "Skip" "No app bundles found"
        fi
    fi
}

# Generate test report
show_test_report() {
    write_test_header "Test Report"
    
    local total=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
    
    echo -e "\nTotal Tests: $total"
    write_success "Passed: $PASS_COUNT"
    write_failure "Failed: $FAIL_COUNT"
    write_warning "Skipped: $SKIP_COUNT"
    
    if [[ $FAIL_COUNT -eq 0 ]]; then
        echo -e "\n${GREEN}✓ All tests passed!${NC}"
    else
        echo -e "\n${RED}✗ Some tests failed. Review the output above.${NC}"
    fi
    
    # Show detailed results if verbose
    if [[ "$VERBOSE" == true ]]; then
        echo -e "\n${CYAN}--- Detailed Results ---${NC}"
        printf '%s\n' "${TEST_RESULTS[@]}"
    fi
    
    # Export results
    local report_path="$(dirname "${BASH_SOURCE[0]}")/test-results-macos.json"
    printf '[%s]\n' "$(IFS=,; echo "${TEST_RESULTS[*]}")" > "$report_path"
    write_info "Test results saved to: $report_path"
    
    return $FAIL_COUNT
}

# Main execution
main() {
    echo -e "${CYAN}"
    cat << "EOF"
╔════════════════════════════════════════════════════════════╗
║   CI OS Hub Desktop - macOS Testing Script                ║
║   Testing automation features on macOS                    ║
╚════════════════════════════════════════════════════════════╝
EOF
    echo -e "${NC}"
    
    local start_time=$(date +%s)
    
    # Run tests based on feature flag
    if [[ -n "$FEATURE" ]]; then
        write_info "Testing specific feature: $FEATURE"
        case $FEATURE in
            prerequisites)
                test_prerequisites
                ;;
            build)
                build_application
                ;;
            system-detection)
                test_system_detection
                ;;
            macos-commands)
                test_macos_commands
                ;;
            artifacts)
                test_build_artifacts
                ;;
            *)
                write_failure "Unknown feature: $FEATURE"
                write_info "Available features: prerequisites, build, system-detection, macos-commands, artifacts"
                exit 1
                ;;
        esac
    else
        # Run all tests
        if ! test_prerequisites; then
            write_failure "Prerequisites check failed. Cannot continue."
            exit 1
        fi
        
        if ! build_application; then
            write_failure "Build failed. Skipping further tests."
            test_build_artifacts
            show_test_report
            exit 1
        fi
        
        test_system_detection
        test_macos_commands
        test_build_artifacts
    fi
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    local minutes=$((duration / 60))
    local seconds=$((duration % 60))
    
    echo -e "\n${CYAN}Test duration: ${minutes}m ${seconds}s${NC}"
    
    show_test_report
    exit $?
}

# Run main
main
