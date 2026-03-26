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

- The frontend dev server (Vite on port 9091) must be running before launching via tauri-driver in dev mode, since `devUrl` points to `http://localhost:9091`.
- The Hub backend must also be running on port 3000 for the app to function.
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

