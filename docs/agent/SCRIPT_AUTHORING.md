# Script authoring

> **Purpose:** How to write bash/TypeScript scripts agents can discover and run reliably.
> **Scope:** `bin/`, `scripts/agent/`, agent-facing CLIs.
> **Examples:** `bin/agent-review`, `bin/agent-validate-shift`, `scripts/agent/*.ts`
> **Router:** [AGENTS.md](../../AGENTS.md)
> **Last updated:** 2026-07-12
> **Related:** AGENT_WORKFLOW.md, package.json scripts

---

## Principles

1. **Discoverable** — register in AGENTS.md and `package.json` scripts
2. **Idempotent** — safe to run twice
3. **Explicit exit codes** — `0` success, non-zero on failure
4. **No interactive prompts** — agents cannot answer mid-run
5. **Document flags** — `--help` on every `bin/` script

---

## Bash scripts (`bin/`)

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
```

- Resolve repo root relative to script location
- Use `pnpm` from root — never assume global install
- Print human-readable step headers (`▶`, `✓`, `✗`)

---

## TypeScript scripts (`scripts/agent/`)

```bash
pnpm exec tsx scripts/agent/my-script.ts
```

- Use `import.meta.dirname` for path resolution (Node 22+)
- Write outputs to known paths under `docs/` or `e2e/results/`
- Log what was written: `console.log('Wrote path (N entries)')`

---

## Registering new scripts

1. Add file to `bin/` or `scripts/agent/`
2. `chmod +x bin/my-script` for bash
3. Add `package.json` script alias: `"agent:my-thing": "..."`
4. Link from [AGENTS.md](../../AGENTS.md)
5. Document in this file

---

## Agent-review pattern

`bin/agent-review` prints a structured prompt. Paste it into a **different** model session. The optional `--cursor` flag suggests which subagent skill to use.

---

## Validate-shift pattern

`bin/agent-validate-shift` runs CI steps in order, stops at the first failure, and supports `--skip-*` for scoped validation.

---

## When to add a script vs a skill

| Use script | Use skill |
|------------|-----------|
| Deterministic commands (lint, test, git log) | Judgment calls (review, audit, sweep analysis) |
| Repeatable gate | Multi-step agent reasoning |
| Fast, no LLM | Needs codebase exploration |

Scripts can **output prompts** for skills to consume.
