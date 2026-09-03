# GitHub Copilot Instructions — CI-Hub

**Start at [AGENTS.md](../AGENTS.md)** — the router for workflow docs, system docs, skills, tools, and validation scripts.

For every session, follow [docs/agent/AGENT_WORKFLOW.md](../docs/agent/AGENT_WORKFLOW.md).

## Essentials

- Stack: NestJS + React 19 + Tauri 2 + Docker Compose + pnpm/Turborepo/Biome
- Run the app: `pnpm run local` (source dev) or `pnpm run local:desktop` (desktop)
- Task queue: [TODO.md](../TODO.md)
- Never use destructive git operations — multiple agents may work simultaneously

Full platform context, package layout, git discipline, and confidentiality notice are in AGENTS.md.
