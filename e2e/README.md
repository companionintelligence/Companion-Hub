# E2E Tests

CI-Hub has two kinds of Playwright coverage:

| Test type | Use it when | What it does | Typical command |
|---|---|---|---|
| Standard E2E specs | You want stable coverage for a known Hub flow | Uses deterministic assertions against fixed UI paths such as auth, dashboard, settings, and app lifecycle flows | `pnpm test:e2e` |
| App Explorer Test | You want to validate a marketplace app end-to-end after install | Installs one app, waits for DNS, signs up or logs in, explores the post-auth UI with AI guidance, and writes a JSON report for triage | `APP_NAME="Activepieces" npx playwright test e2e/app-explorer.spec.ts --reporter=list` |

## When to use the App Explorer Test

Use the App Explorer Test when you need to:

- verify that a self-hosted marketplace app can be installed and opened from CI-Hub
- get past the first login or sign-up screen and inspect the real app interior
- explore unfamiliar apps without hand-authoring a static script first
- produce a structured report that can feed the automated diagnostics and fix loop

Prefer the standard E2E suite when you need:

- deterministic pass/fail checks for a known Hub workflow
- coverage for regressions inside CI-Hub itself rather than inside installed apps
- fast local verification while changing frontend or backend product code

## App Explorer Test setup

### 1. Local dependencies

```bash
pnpm install
pnpm exec playwright install chromium
```

Clone the marketplace repo separately and point `MARKETPLACE_DIR` at it before running the explorer.

### 2. Runtime prerequisites

- Docker or OrbStack running locally so CI-Hub can install app containers
- wildcard DNS for `*.ci.lan` and `*.ci.computer` to `127.0.0.1`
- a running CI-Hub instance that can install apps from the marketplace

### 3. Ollama requirements

Some E2E workflows in this repository exercise Hub AI features and expect Ollama to be available to the Hub runtime. The backend defaults to `http://ci-hub-ollama:11434`, while the local Docker compose setup points Hub at `http://host.docker.internal:11434`, so make sure your local Ollama server is reachable from the Hub process and has at least one model pulled.

Example local setup:

```bash
ollama serve
ollama pull qwen3:8b
```

### 4. Explorer environment

Create `.env.explorer` in the repository root:

```bash
HUB_URL=http://localhost:9091
TEST_EMAIL=test@ci.computer
TEST_PASSWORD=testpassword123

APP_TEST_EMAIL=explorer@ci.computer
APP_TEST_PASSWORD=Explorer123!
APP_TEST_NAME=CI Explorer

APP_DOMAIN=ci.computer
EXPLORE_MINUTES=5
DNS_TIMEOUT_MINUTES=10

MARKETPLACE_DIR=~/Development/companion/ci-marketplace
REPORT_DIR=~/Development/companion/reports
SCREENSHOT_DIR=~/Development/companion/screenshots

OPENAI_API_KEY=sk-...
```

`OPENAI_API_KEY` enables the current AI-guided auth, exploration, and diagnosis paths. Without it, the App Explorer falls back to basic heuristics.

## Running the App Explorer Test

Single app:

```bash
cd ~/Development/companion/ci-hub

APP_NAME="Activepieces" \
  $(cat .env.explorer | grep -v '^#' | xargs) \
  npx playwright test e2e/app-explorer.spec.ts --reporter=list
```

Explorer plus automated fix loop:

```bash
./agent/scripts/run-explorer.sh "Activepieces"
./agent/scripts/run-explorer.sh "Nextcloud" --dry-run
```

## Example reports

Healthy report excerpt:

```json
{
  "app": "Activepieces",
  "verdict": "healthy",
  "steps": {
    "install": { "status": "pass" },
    "dns": { "status": "pass", "attempts": 3 },
    "auth": { "status": "pass", "method": "signed-up" },
    "explore": { "status": "pass", "actionsCount": 42, "errorsCount": 3 }
  },
  "issues": []
}
```

Degraded report excerpt:

```json
{
  "app": "Nextcloud",
  "verdict": "dns-timeout",
  "steps": {
    "dns": {
      "status": "fail",
      "reason": "dns-timeout",
      "lastError": "net::ERR_NAME_NOT_RESOLVED"
    }
  },
  "issues": [
    "DNS/boot timeout after 10 min (60 attempts): https://nextcloud.ci.computer"
  ]
}
```

The JSON report is the primary artifact for triage. App Explorer does not use screenshot assertions to decide pass or fail; any screenshots captured during a run are supplemental debug artifacts only.

## More detail

For the full diagnose → patch → verify loop, report schema, and fix-agent workflow, see [../docs/FLYWHEEL.md](../docs/FLYWHEEL.md).
