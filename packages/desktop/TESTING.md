# Tauri Desktop App — Automated Testing & Control

## Overview

The CI Hub desktop app uses Tauri v2 with WebKitGTK on Linux. For automated testing and programmatic control, we use the W3C WebDriver protocol via `tauri-driver` and `WebKitWebDriver`.

## Architecture

```
Test Script / Agent → tauri-driver (:4444) → WebKitWebDriver → Tauri WebView (WebKitGTK)
```

- **tauri-driver** — Tauri's cross-platform WebDriver wrapper. Translates W3C WebDriver commands to the native platform driver.
- **WebKitWebDriver** — Native WebDriver for WebKitGTK (Linux). Provided by the `webkit2gtk-driver` package.

## Prerequisites

### Linux (Ubuntu/Debian)

```bash
# Install WebKitWebDriver
sudo apt-get install -y webkit2gtk-driver

# Install tauri-driver
cargo install tauri-driver --locked

# Verify
which WebKitWebDriver   # /usr/bin/WebKitWebDriver
which tauri-driver       # ~/.cargo/bin/tauri-driver
```

### macOS

macOS does not have a native WKWebView WebDriver. Use `tauri-plugin-webdriver-automation` instead (see Alternatives below).

### Windows

Uses Microsoft Edge WebDriver. See [Tauri WebDriver docs](https://v2.tauri.app/develop/tests/webdriver).

## Usage

### 1. Start tauri-driver

```bash
tauri-driver --port 4444
```

### 2. Create a session (launches the app)

```bash
curl -X POST http://localhost:4444/session \
  -H "Content-Type: application/json" \
  -d '{
    "capabilities": {
      "alwaysMatch": {
        "tauri:options": {
          "application": "/path/to/ci-os-hub-desktop"
        }
      }
    }
  }'
```

Response includes a `sessionId` used for all subsequent commands.

### 3. Interact with the app

Standard W3C WebDriver commands work:

```bash
SESSION="<session-id>"
BASE="http://localhost:4444/session/$SESSION"

# Get current URL
curl -s $BASE/url

# Get page title
curl -s $BASE/title

# Find element by CSS selector
curl -s -X POST $BASE/element \
  -H "Content-Type: application/json" \
  -d '{"using": "css selector", "value": "input[type=email]"}'

# Type into element
curl -s -X POST $BASE/element/<element-id>/value \
  -H "Content-Type: application/json" \
  -d '{"text": "user@example.com"}'

# Click element
curl -s -X POST $BASE/element/<element-id>/click \
  -H "Content-Type: application/json" -d '{}'

# Take screenshot (returns base64 PNG)
curl -s $BASE/screenshot

# Execute JavaScript
curl -s -X POST $BASE/execute/sync \
  -H "Content-Type: application/json" \
  -d '{"script": "return document.title", "args": []}'
```

### 4. End session

```bash
curl -s -X DELETE http://localhost:4444/session/$SESSION
```

## Using with Selenium / WebDriverIO

### WebDriverIO

```javascript
// wdio.conf.mjs
export const config = {
  port: 4444,
  capabilities: [{
    'tauri:options': {
      application: './src-tauri/target/debug/ci-os-hub-desktop',
    }
  }],
};
```

### Selenium (Node.js)

```javascript
const { Builder } = require('selenium-webdriver');
const driver = await new Builder()
  .usingServer('http://localhost:4444')
  .withCapabilities({
    'tauri:options': {
      application: './src-tauri/target/debug/ci-os-hub-desktop',
    }
  })
  .build();

await driver.getTitle(); // "Companion Hub"
```

## Important Notes

- The frontend dev server (Vite on port 5005) must be running before launching via tauri-driver in dev mode, since `devUrl` points to `http://localhost:5005`.
- The Hub backend must also be running on port 5004 for the app to function.
- `xdotool` does NOT work reliably with WebKitGTK webviews — always use WebDriver instead.
- Screenshots via the WebDriver `/screenshot` endpoint return base64-encoded PNG data.

## Alternatives

### tauri-plugin-webdriver-automation (macOS)

For macOS where no native WKWebView WebDriver exists:

```toml
# Cargo.toml
tauri-plugin-webdriver-automation = "0.1"
```

```rust
// main.rs (debug builds only)
#[cfg(debug_assertions)]
builder = builder.plugin(tauri_plugin_webdriver_automation::init());
```

### tauri-plugin-automation-server

HTTP API embedded in the app for external control:

```toml
tauri-plugin-automation-server = { git = "https://github.com/dcherrera/tauri-plugin-automation" }
```

## References

- [Tauri WebDriver docs](https://v2.tauri.app/develop/tests/webdriver)
- [tauri-driver crate](https://crates.io/crates/tauri-driver)
- [W3C WebDriver spec](https://www.w3.org/TR/webdriver2/)
- [danielraffel/tauri-webdriver](https://github.com/danielraffel/tauri-webdriver) (macOS)


## Windows — WebView2 DevTools & Remote Debugging

On Windows, the Tauri app uses Microsoft Edge WebView2. DevTools are available in two ways:

### 1. Built-in DevTools (F12)

In **debug builds** (`cargo build` / `cargo tauri dev`), DevTools open automatically on launch.

In **release builds**, set the environment variable before launching:
```cmd
set COMPANION_HUB_DEBUG=1
C:\workspaces\CI-Hub\packages\desktop\src-tauri\target\release\ci-os-hub-desktop.exe
```

This opens the Edge DevTools panel attached to the WebView, giving you:
- Console (view errors, logs)
- Network tab (inspect API calls, CORS issues)
- Elements (DOM inspection)
- Sources (JS debugging)

### 2. Remote Debugging via CDP

WebView2 supports Chrome DevTools Protocol for remote/headless debugging:

```cmd
@echo off
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
C:\workspaces\CI-Hub\packages\desktop\src-tauri\target\release\ci-os-hub-desktop.exe
```

Save as `debug-tauri.cmd` and run it. Then connect from any machine:

```bash
# List available debug targets
curl -s http://<windows-ip>:9222/json

# Open in Chrome/Edge on another machine
# Navigate to: chrome://inspect → Configure → add <windows-ip>:9222
```

Or from CLI via curl:
```bash
# Get the WebSocket URL for the page
WS_URL=$(curl -s http://localhost:9222/json | jq -r '.[0].webSocketDebuggerUrl')

# Execute JavaScript via CDP
curl -s http://localhost:9222/json/version
```

### 3. Using Edge DevTools from the Windows machine

When the app is running with `COMPANION_HUB_DEBUG=1`:
1. Open Microsoft Edge
2. Navigate to `edge://inspect`
3. The Tauri WebView should appear under "Other targets"
4. Click "inspect" to open full DevTools

### Common debugging commands via CDP

```bash
# Get current page URL
curl -s http://localhost:9222/json | jq '.[0].url'

# Get page title
curl -s http://localhost:9222/json | jq '.[0].title'

# Take screenshot (via WebSocket — use wscat or similar)
# Or use the DevTools UI from edge://inspect
```

### Debugging API connection issues

To verify the frontend can reach the backend in release mode:

```cmd
set COMPANION_HUB_DEBUG=1
ci-os-hub-desktop.exe
```

Then in the DevTools Console:
```javascript
// Check what baseUrl is configured
import('@/api-client/client.gen').then(m => console.log(m.client.getConfig()))

// Test direct fetch to backend
fetch('http://localhost:5002/api/health').then(r => r.json()).then(console.log)

// Check for CORS errors in the Network tab
```
