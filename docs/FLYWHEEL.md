# App Explorer Test — Handoff Guide

> **Who this is for:** Any agent or engineer picking this up on a new machine to run the App Explorer Test, triage failures, and submit fixes to ci-marketplace via automated PRs.

---

## What this is

This guide covers the App Explorer Test and the automated diagnose/fix loop it feeds for ci-marketplace apps:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. EXPLORE   app-explorer.spec.ts                              │
│     Install any app from ci-hub → wait for DNS → create        │
│     account → AI-guided 5-min exploration → write report       │
├─────────────────────────────────────────────────────────────────┤
│  2. DIAGNOSE  agent/lib/diagnostics.ts                          │
│     On degraded verdict: classify failure category →           │
│     local heuristics first, GPT-4o for complex cases           │
├─────────────────────────────────────────────────────────────────┤
│  3. FIX       agent/fix-agent.ts                                │
│     Patch config.json or docker-compose.json → bun verify:app  │
│     → commit → open PR on ci-marketplace                       │
└─────────────────────────────────────────────────────────────────┘
         └──── fix PR merged ──── next run passes ────┘
```

---

## Repo layout

```
ci-hub/
  e2e/
    app-explorer.spec.ts        ← thin orchestrator (4 steps)
    lib/
      config.ts                 ← types, marketplace loader, field classifier
      reporter.ts               ← report state, screenshots, verdict, fix-request writer
      install-form.ts           ← reads config.json → fills hub install form
      app-auth.ts               ← creates account / logs in on the installed app
      ai-explorer.ts            ← AI interaction loop (GPT-4o-mini or heuristic)
  agent/
    fix-agent.ts                ← fix pipeline: diagnose → patch → verify → PR
    status-server.ts            ← observability HTTP server (port 3099)
    lib/
      diagnostics.ts            ← failure categorisation + local heuristics + AI diagnosis
    scripts/
      run-explorer.sh           ← one-command runner (explorer + fix agent)
    results/
      status.json               ← live agent state (updated after every step)

ci-marketplace/
  apps/<app-id>/
    config.json                 ← form fields, defaults, version
    docker-compose.json         ← services, images, env vars
```

---

## Machine setup

### 1. Clone repos

```bash
mkdir -p ~/Development/companion && cd ~/Development/companion

git clone git@github.com:companionintelligence/ci-hub.git
git clone git@github.com:companionintelligence/ci-marketplace.git

# Both must be on the dev branch
cd ci-hub && git checkout dev
cd ../ci-marketplace && git checkout dev
```

### 2. Install dependencies

```bash
# ci-hub
cd ~/Development/companion/ci-hub
pnpm install
pnpm exec playwright install chromium

# ci-marketplace
cd ~/Development/companion/ci-marketplace
bun install

# agent
cd ~/Development/companion/ci-hub/agent
npm install          # openai, ts-node, typescript, @types/node
```

### 3. Environment variables

Create `~/Development/companion/ci-hub/.env.explorer`:

```bash
# Hub credentials
HUB_URL=http://localhost:9091
TEST_EMAIL=test@ci.computer
TEST_PASSWORD=testpassword123

# App account credentials (used when sign-up form is detected)
APP_TEST_EMAIL=explorer@ci.computer
APP_TEST_PASSWORD=Explorer123!
APP_TEST_NAME=CI Explorer

# Base domain for app subdomains
APP_DOMAIN=ci.computer

# Timing
EXPLORE_MINUTES=5
DNS_TIMEOUT_MINUTES=10

# Paths (adjust to your machine)
MARKETPLACE_DIR=~/Development/companion/ci-marketplace
REPORT_DIR=~/Development/companion/reports
SCREENSHOT_DIR=~/Development/companion/screenshots

# AI (required for guided exploration + AI diagnosis)
OPENAI_API_KEY=sk-...

# Fix agent
DRY_RUN=true    # set false when ready to push real PRs
```

Create `~/Development/companion/ci-hub/agent/.env`:
```bash
OPENAI_API_KEY=sk-...
MARKETPLACE_DIR=~/Development/companion/ci-marketplace
REPORT_DIR=~/Development/companion/reports
LOG_DIR=~/Development/companion/logs
DRY_RUN=true
```

### 4. Start ci-hub

You need a running ci-hub instance for the explorer to install apps through. Options:

**Local Docker (full stack):**
```bash
cd ~/Development/companion/ci-hub
docker-compose -f e2e/docker-compose.e2e.yml up -d
```

**Remote hub:** Set `HUB_URL=https://your-ci-hub-instance.ci.computer`

---

## Running App Explorer

### Single app — full loop

```bash
cd ~/Development/companion/ci-hub

APP_NAME="Activepieces" \
  $(cat .env.explorer | grep -v '#' | xargs) \
  npx playwright test e2e/app-explorer.spec.ts --reporter=list
```

Or use the runner script which chains explorer → fix agent automatically:

```bash
./agent/scripts/run-explorer.sh "Activepieces"
./agent/scripts/run-explorer.sh "Nextcloud" --dry-run
```

### Batch — verify all apps

```bash
# Generate a list of all app names
python3 -c "
import json, glob
for p in sorted(glob.glob('../ci-marketplace/apps/*/config.json')):
    d = json.load(open(p))
    print(d.get('name', ''))
" > /tmp/all-apps.txt

# Run explorer on each
while read APP; do
  [ -z "$APP" ] && continue
  echo "▶ $APP"
  APP_NAME="$APP" npx playwright test e2e/app-explorer.spec.ts \
    --reporter=list --timeout=900000 2>&1 | tail -5
done < /tmp/all-apps.txt
```

### Run just the fix agent (after reports are already written)

```bash
cd ~/Development/companion/ci-hub/agent
WATCH=true npx ts-node fix-agent.ts
```

### Start the observability dashboard

```bash
cd ~/Development/companion/ci-hub/agent
npx ts-node status-server.ts
# → http://localhost:3099
```

---

## Reading a report

Reports are JSON written to `reports/<app-id>-<timestamp>.json`.

```json
{
  "app": "Activepieces",
  "appId": "activepieces",
  "version": "0.77.6",
  "verdict": "healthy | degraded | partial | dns-timeout | unknown",
  "steps": {
    "install": {
      "status": "pass | fail | timeout",
      "filledFieldCount": 2,
      "unfillableFields": [],
      "appUrl": "https://activepieces.ci.computer",
      "notes": ["Filled: Encryption Key = ***", "Selected: Public Web exposure"]
    },
    "dns": {
      "status": "pass | fail",
      "attempts": 3,
      "resolvedAfterMs": 30000,
      // on failure:
      "reason": "dns-timeout",
      "lastError": "net::ERR_NAME_NOT_RESOLVED",
      "note": "App URL did not become reachable within 10 minutes..."
    },
    "auth": {
      "status": "pass | warn",
      "method": "signed-up | logged-in | already-authed | ai-guided | failed",
      "notes": ["Filled email", "Filled password", "Submitted sign-up form"]
    },
    "explore": {
      "status": "pass | warn",
      "actionsCount": 42,
      "errorsCount": 3,
      "errors": ["Click: some-button: timeout"]
    }
  },
  "userVisibleConfig": [
    {
      "label": "Admin Email",
      "env_variable": "APP_ADMIN_EMAIL",
      "value": "admin@ci.computer",
      "reason": "User-configurable setting — review before production use"
    }
  ],
  "issues": [],
  "screenshots": ["screenshots/2026-05-01/activepieces/01-store-search-....png"]
}
```

The JSON report is the source of truth for pass/fail and triage. Screenshots are optional debug artifacts only; the App Explorer Test does not use screenshot assertions.

**Verdict meanings:**

| Verdict | Meaning |
|---|---|
| `healthy` | All steps passed |
| `degraded` | One or more steps failed — fix-request written |
| `partial` | Some steps ran, others inconclusive |
| `dns-timeout` | App URL never resolved — DNS or container boot failure |
| `unknown` | Test aborted before finalise |

---

## Fix agent workflow

When a report has `verdict: degraded` or `dns-timeout`, a `fix-request-<app>-<ts>.json` is written to `reports/`. The fix agent processes these automatically.

**Failure categories the agent knows about:**

| Category | What it means | Auto-fix |
|---|---|---|
| `missing-required` | Required field in config.json has no default | Adds sensible default |
| `user-visible-var` | Default is "changeme" or placeholder | Overrides + flags in PR |
| `container-unhealthy` | Main service has no healthcheck | Adds healthcheck to docker-compose.json |
| `wrong-image` | Pull error, 403, manifest unknown | AI diagnoses correct tag |
| `bad-env-var` | Hardcoded bad value in docker-compose.json | AI suggests correct value |
| `install-timeout` | App didn't reach running state in 3 min | AI diagnoses root cause |
| `dns-timeout` | URL never reachable | AI checks image/port/expose config |
| `auth-failed` | Couldn't create account on app | AI suggests auth config fixes |

**Fix agent PR format:**

Every PR includes:
- Categories detected
- Diagnosis paragraph
- Suggestions for human review
- List of `userVisibleConfig` fields the operator should set before going to production

---

## Adding a new app to App Explorer coverage

1. Add the app to ci-marketplace (`apps/<id>/config.json` + `docker-compose.json`)
2. Run the explorer:
   ```bash
   ./agent/scripts/run-explorer.sh "My App Name"
   ```
3. Check the report — fix any `userVisibleConfig` fields that need real values
4. If the agent opens a PR → review + merge
5. Run again to confirm `verdict: healthy`

That's the full App Explorer loop. Iterate until green.

---

## Common issues

**"App not found in marketplace"**
→ The appId fuzzy-match failed. Set `APP_NAME` to exactly match the `name` field in the app's `config.json`.

**`dns-timeout` on first run**
→ Normal for newly installed apps. DNS propagation for new subdomains can take 2–15 min. Re-run with `DNS_TIMEOUT_MINUTES=15`.

**Auth fails on every app**
→ Check `APP_TEST_EMAIL` / `APP_TEST_PASSWORD` env vars. Some apps reject weak passwords — try `APP_TEST_PASSWORD=Explorer123!@#`.

**Fix agent opens PR but bun verify:app fails**
→ The patch was too aggressive. Check `logs/fix-agent.log` for the verify output. Set `DRY_RUN=true` and inspect the patched file manually.

**AI exploration does nothing useful**
→ Set `OPENAI_API_KEY`. Without it, the explorer uses a dumb heuristic (click first button, wait, repeat).

---

## Observability

| URL | What |
|---|---|
| `http://localhost:3099` | Fix agent dashboard (auto-refresh 15s) |
| `http://localhost:3099/api/status` | Agent queue / completed / errors JSON |
| `http://localhost:3099/api/reports` | All reports with verdicts |
| `http://localhost:3099/api/logs` | Last 200 lines of fix-agent.log |
| `http://localhost:3099/api/screenshots` | Screenshot inventory |

Over Tailscale: replace `localhost` with your node's Tailscale IP.
