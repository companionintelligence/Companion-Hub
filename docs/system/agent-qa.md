# Agent QA system — Companion Hub

> **Purpose:** Marketplace app exploration, diagnose/fix loop — separate from general dev workflow.
> **Scope:** `agent/`, `e2e/app-explorer.spec.ts`, `docs/FLYWHEEL.md`
> **Key paths:** `agent/fix-agent.ts`, `agent/lib/diagnostics.ts`, `docs/FLYWHEEL.md`
> **Commands:** `agent/scripts/run-explorer.sh`
> **Owner persona:** domain (marketplace/apps)
> **Last updated:** 2026-10-27
> **Related:** docs/system/e2e.md, docs/agent/AGENT_WORKFLOW.md (general work)

---

## Not general development

This system is **only** for ci-marketplace app QA automation. Feature work and bugfixes use [AGENT_WORKFLOW.md](../agent/AGENT_WORKFLOW.md).

## Flywheel loop

```
EXPLORE  → app-explorer.spec.ts installs + AI-explores apps
DIAGNOSE → agent/lib/diagnostics.ts classifies failures
FIX      → agent/fix-agent.ts patches ci-marketplace → opens PR
```

Full guide: [docs/FLYWHEEL.md](../FLYWHEEL.md)

## agent/ directory

- Separate npm lockfile — **not** in pnpm workspace
- **Do not import** from `agent/` into Hub packages
- Not run in standard CI (`ci.yml`)

## Fleet QA

Multi-node Tailscale fleet runners and host inventories are **not published** in this repository
(companionintelligence/CI-Hub#1210 / companionintelligence/CI-Engineering#211). Use local
`scripts/qa-stream.ts` against a single machine, or the private ops mirror for fleet orchestration.

For local no-GUI service checks, the runner uses the main compose service's declared TCP
`internalPort` for readiness and suppresses screenshots; no-GUI MCP apps continue through the
stdio protocol lane. Portless and UDP-only services are skipped. A silent TCP endpoint is never
passed on the Docker proxy handshake alone: on Linux, the runner reads the container network
namespace TCP tables through the host's `/proc/<pid>/net` view, without executing image-provided
tools. It then accepts only a known datastore image or a protocol greeting. SQL Server is accepted
only for Microsoft's canonical image paths. On non-Linux hosts where Docker Desktop's VM namespace
is not visible, this evidence remains unknown and silent services are skipped. If a required TCP
procfs snapshot is unreadable or incomplete, the app is skipped as unsupported rather than passed or
reported as definitely closed. A present but unreadable IPv4 or IPv6 table also makes the result
unknown.

Generated QA environment values follow the Marketplace form-field contract. Password fields get a
fresh alphanumeric value containing uppercase, lowercase, and digits, with declared minimum and
maximum lengths honored. The value avoids punctuation so it remains safe through Compose and shell
boundaries. Other secret fields keep opaque random values.

## Agent notes

- Status server: `agent/status-server.ts` (port 3099)
- Reports written to `agent/results/`
- For general Hub development, ignore this system unless explicitly doing marketplace QA

## Remote runner control

The private fleet QA controller may copy `scripts/qa-stream.ts` to a node and set
`QA_RUN_PID_FILE` to a run-specific marker path. The runner writes its PID there, drains active
app checks when it receives `SIGTERM` or `SIGINT`, and removes the marker on exit. This is a
scoped stop contract: operators and controllers must close the work feed or signal the recorded
PID, never use a fleet-wide `pkill` that could terminate another QA session.

The async command runner also enforces its deadline independently of child-process `close` events.
It starts commands in a process group on POSIX, kills that group on timeout or output overflow,
closes captured pipes, and settles immediately. This prevents a descendant that inherited stdout or
stderr from keeping a QA worker stuck after its shell exits. A signal-terminated command or
signal-style exit code is marked interrupted as well.

When that marker contains a fleet run token, the runner also namespaces its Docker container names
and Compose project names with the token. This keeps an orphaned resource from an earlier run from
blocking a later run for the same app. Direct `qa-stream.ts` CLI use without `QA_RUN_PID_FILE`
keeps the legacy names for compatibility.

Transient retries distinguish a readiness timeout from a Docker start-command timeout. A readiness
or compose dependency timeout is retried only after teardown confirms that the run-scoped container
name and Compose project are gone. A timed-out or interrupted Docker start is reported without an
automatic retry under the same name: the daemon may have created the container even after the local
Docker CLI stopped, and an immediate retry can turn that interruption into a misleading name
conflict. A host-port bind retry is also skipped for any interrupted command. Every host-port
retry verifies that the previous container and any run-scoped Compose containers, networks, and
volumes were removed first; otherwise the original start failure is preserved and the retry is
suppressed. Compose timeout classification records both output channels and the process timeout
before diagnostics are truncated.

Fleet screenshots use the Playwright Chromium API and stop navigation at `DOMContentLoaded`, so
long-lived app requests do not block capture. They wait a bounded interval for SPA content to render,
and enforce capture and browser-cleanup deadlines. The fleet command passes `QA_HUB_ROOT` for
resolving the installed `@playwright/test`; nodes without that module use the existing Chromium CLI
fallback.
