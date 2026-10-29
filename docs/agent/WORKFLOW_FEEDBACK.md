# Workflow Feedback

Rolling notes on the CI-Hub agent workflow. See [session worksheets](sessions/README.md) for context.

> 2026-10-28 — imageboot-registry-fallback: Retry Docker Hub and fall back to public ECR for image-boot dependencies, with registry errors visible.

> 2026-10-28 — hub-release-gate-fixes: Build common packages before tests, preserve separate custom-domain transfer/conflict coverage, and generate OOBI schemas with the API client.

> 2026-10-28 — fleetqa-browser-capture-reliability: Isolated worktrees kept the long fleet app campaign running while focused Playwright checks exercised async rendering and open SSE; pnpm's dependency guard refused to replace the shared `node_modules` symlink, so add a documented no-install validation path for temporary worktrees.

> 2026-10-27 — qa-start-timeout-cleanup: Bound process deadlines independently of inherited pipes, verify all run-scoped Docker resources before retry, and test the child-process lifecycle with a real subprocess.
