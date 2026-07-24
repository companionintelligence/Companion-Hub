---
name: test-audit
description: Audit CI-Hub tests for false confidence — tests that don't test what they claim. Use periodically or before large refactors.
---

# False-Confidence Test Audit — CI-Hub

## Inventory

Read [docs/agent/TEST_INVENTORY.md](../../docs/agent/TEST_INVENTORY.md) and [docs/agent/TESTING.md](../../docs/agent/TESTING.md).

## Audit checklist

For each test file in scope:

1. **Name vs assertion** — Does `it('...')` describe what is actually asserted?
2. **Mock boundary** — Is the code under test mocked away?
3. **Always passes** — Assertions that cannot fail (tautologies, `expect(true)`)
4. **Wrong signal** — e.g. fetch stub always returns ok while testing unhealthy→healthy transitions
5. **Implementation detail** — Testing internal state instead of user-visible behavior
6. **Missing negative cases** — Only happy path covered

## Hub-specific smells

- `vi.spyOn` on module already imported by SUT (use `vi.hoisted` + `vi.mock`)
- `hub-status` tests without controlling `probeHealthyHubApiPort`
- `!` non-null assertions in tests (Biome CI failure)
- `findByText` with `vi.useFakeTimers()` (hangs)

## Output

| File | Test | Issue | Suggested fix |
|------|------|-------|---------------|

Fix high-confidence false tests in the same session if user asked for audit+fix.

Regenerate inventory after changes: `pnpm run agent:test-inventory`
