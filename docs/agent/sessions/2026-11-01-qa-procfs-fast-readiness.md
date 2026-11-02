# Session Worksheet — QA procfs fast readiness

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `qa-procfs-fast-readiness` |
| **Date** | 2026-11-01 |
| **Agent** | Codex |
| **Model** | GPT-6 |
| **Task** | User request: address remaining platform release gaps |

## Goal

Make Marketplace QA reliably recognize known database services from trusted container procfs evidence, without waiting through an HTTP-only readiness timeout or sending HTTP protocol bytes to database ports.

## Steps taken

1. Ran the merged Hub harness against PostgreSQL on `core-14`; it incorrectly returned `skip` after 450 seconds because the internal listener remained unknown to the final probe.
2. Confirmed from the fleet host that the same PostgreSQL image exposes its listener through `/proc/<pid>/net/tcp` when inspected with the host user.
3. Independent reviews found false-pass and portability risks. Tightened readiness to require IPv4 published reachability plus a wildcard/container IPv4 listener, kept IPv6-only binds unknown until an IPv6 published path is proven, restricted readiness to protocol-specific ports, preserved HTTP checks elsewhere, and added bounded failure diagnostics and tests.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Accept known protocol endpoints only after IPv4 published TCP reachability and an IPv4 wildcard or container-IP listener. | A published Docker proxy handshake plus a loopback-only or unverified IPv6 listener is insufficient. |
| Do not send HTTP bytes to known no-GUI wire-protocol ports. | Those bytes are invalid protocol input and provide no readiness signal; HTTP-capable ports, including etcd's 2379, keep their HTTP probe. |
| Include the cause when procfs cannot be inspected in the final result. | A fleet skip should distinguish Docker inspect, PID, and procfs read failures. |

## Files touched

- `scripts/qa-stream.ts`
- `scripts/__tests__/qa-route-policy.test.ts`
- `docs/system/agent-qa.md`
- This session worksheet and feedback.

## Tests run

- [x] Focused policy suite: 26 tests passed, including the IPv6-wildcard/proxy regression.
- [x] Biome check on changed TypeScript files.
- [x] `pnpm run lint:ci` (passed in final `agent:validate` run).
- [x] `pnpm run tsc` (passed in final `agent:validate` run).
- [x] `pnpm test`: 137 files, 3,394 passed, 32 skipped (passed in final `agent:validate` run).
- [ ] Fleet rerun with the updated harness.
- [x] `bin/agent-validate-shift --skip-visual --skip-benchmark` (passed; visual and benchmark checks skipped as requested by the documented QA command).

## Open items / handoff

The updated harness still needs to be promoted and tested against PostgreSQL and SQL Server. The previous PostgreSQL run used the merged prior harness and scored `skip`; it is not a pass. Full Hub validation passed. Independent security/correctness review found no remaining actionable issues in the current diff; live fleet reruns remain outstanding.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| Final | Security/correctness | Independent subagent | No remaining actionable issues found; reviewed protocol policy, published-port evidence, diagnostics, IPv6 handling, and regression coverage. |
