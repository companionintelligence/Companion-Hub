# Workflow Feedback

Rolling notes on the CI-Hub agent workflow. See [session worksheets](sessions/README.md) for context.

> 2026-11-01 — qa-procfs-probe: Read Linux container sockets through trusted host procfs, constrain SQL Server image evidence, and test unsupported-platform uncertainty.

> 2026-11-01 — qa-password-policy: Generate policy-compliant password values for app QA and add coverage for bounds, character classes, and freshness.

> 2026-10-30 — agent-store-portability: Compared the agent packaging of store A and store B, documented Hub trust boundaries, and recorded the OpenClaw wrapper quarantine and cross-repo bootstrap sync.
> 2026-10-30 — hub-workflow-hygiene: Run workflow rules from the test suite because every workflow is dispatch-only, and plant each defect in a guard one at a time to find the assertions that cannot fail.
> 2026-10-30 — hub-keri-freeze: Compare lint and test results against the base as sets when the gate is red there, and run the real collaborator behind a controller test when a mock would only echo the expected value.

> 2026-10-28 — headless-http-app-qa: Added HTTP/TCP checks for supported no-GUI apps and synced Hub API artifacts; the active fleet campaign uses the earlier runner, so harness-versioned targeted retesting remains necessary.

> 2026-10-28 — imageboot-registry-fallback: Retry Docker Hub and fall back to public ECR for image-boot dependencies, with registry errors visible.

> 2026-10-28 — hub-release-gate-fixes: Build common packages before tests, preserve separate custom-domain transfer/conflict coverage, and generate OOBI schemas with the API client.

> 2026-10-28 — fleetqa-browser-capture-reliability: Isolated worktrees kept the long fleet app campaign running while focused Playwright checks exercised async rendering and open SSE; pnpm's dependency guard refused to replace the shared `node_modules` symlink, so add a documented no-install validation path for temporary worktrees.

> 2026-10-27 — qa-start-timeout-cleanup: Bound process deadlines independently of inherited pipes, verify all run-scoped Docker resources before retry, and test the child-process lifecycle with a real subprocess.
