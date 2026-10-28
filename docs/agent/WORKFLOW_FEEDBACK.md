# Workflow Feedback

Rolling notes on the CI-Hub agent workflow. See [session worksheets](sessions/README.md) for context.

> 2026-10-28 — headless-http-app-qa: Added HTTP/TCP checks for supported no-GUI apps and synced Hub API artifacts; the active fleet campaign uses the earlier runner, so harness-versioned targeted retesting remains necessary.

> 2026-10-28 — fleetqa-browser-capture-reliability: Isolated worktrees kept the long fleet app campaign running while focused Playwright checks exercised async rendering and open SSE; pnpm's dependency guard refused to replace the shared `node_modules` symlink, so add a documented no-install validation path for temporary worktrees.

> 2026-10-27 — qa-start-timeout-cleanup: Bound process deadlines independently of inherited pipes, verify all run-scoped Docker resources before retry, and test the child-process lifecycle with a real subprocess.
