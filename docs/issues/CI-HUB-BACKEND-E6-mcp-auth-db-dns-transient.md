# CI-HUB-BACKEND-E6: MCP auth error flood on transient DB DNS failures

## Status
- **State:** Open
- **Priority:** High
- **Surface:** `POST /api/mcp`
- **Sentry issue:** `CI-HUB-BACKEND-E6`

## Summary
Production Hub instances are emitting a high-volume handled error during MCP authentication when the API key lookup hits transient database DNS/connectivity failures (for example `getaddrinfo EAI_AGAIN ci-hub-db`).

The failure is currently grouped as an error-level issue and appears as:

- `Failed query: select ... from api_key ... where hashed_key = $1 and audience = $2`
- request path: `POST /api/mcp`
- observed behavior: repeated auth-path failures under transient DB reachability pressure

## Impact
- MCP clients (including extension/agent flows) intermittently fail initialization/auth checks.
- Operators see noisy high-severity Sentry signal that obscures real regressions.
- Retriable infra hiccups are presented like app-logic failures.

## Evidence
- Sentry issue reports `Error: getaddrinfo EAI_AGAIN ci-hub-db` in breadcrumb chain.
- Stack trace points to MCP auth lookup path during token validation on `POST /api/mcp`.
- Event volume is high (`~10k`) and ongoing, indicating repeated transient infrastructure events rather than isolated bad credentials.

## Expected behavior
- Transient DB unavailability on auth lookup should:
  - fail fast with a retriable service response (`503`) rather than auth-invalid semantics;
  - avoid error-level escalation per request;
  - preserve one grouped infrastructure signal for outage visibility.

## Current behavior
- MCP auth path still emits handled query errors at high volume in production.
- Sentry groups these as active error-level events for this endpoint.

## Likely root cause
- Production release running this issue appears to still exercise a code path that performs direct MCP API-key validation query without consistently routing through resilient retry + transient-classification handling.
- During Docker DNS jitter / DB reconnect windows (`EAI_AGAIN`, similar transient connectivity faults), query exceptions bubble into noisy handled errors instead of consistently becoming `ApiKeyStoreUnavailable`-style infra responses and warning-level grouped telemetry.

## Proposed fix plan
1. **Unify MCP auth lookup path**
   - Ensure MCP auth always uses the shared resilient API-key resolution path (`ApiKeyService.resolve(...)` with transient retry wrapping), with no legacy direct query path.
2. **Enforce transient-to-503 semantics**
   - On exhausted transient DB retries, return `503` from MCP auth guard with stable message.
3. **Normalize telemetry classification**
   - Ensure transient auth-store failures are tagged/fingerprinted as `transient-db-unreachable` and downgraded to warning-level in Sentry scrubbing.
4. **Backfill regression tests**
   - MCP guard/service tests for:
     - `EAI_AGAIN` -> retry then success;
     - retries exhausted -> `ApiKeyStoreUnavailableError` -> `503`;
     - no error-level noise path for expected transient failures.
5. **Rollout validation**
   - Confirm event rate drop for `CI-HUB-BACKEND-E6` after deploy.
   - Confirm new grouped warning remains visible for infra outages.

## Acceptance criteria
- `POST /api/mcp` auth path no longer emits high-volume error-level Sentry events for transient DB reachability failures.
- Transient DB auth-store failures consistently produce retriable `503` responses.
- Sentry shows grouped warning-level infra signal instead of per-query handled errors.
- MCP initialize and subsequent tool calls recover successfully across brief DB/DNS blips.

## Owner suggestions
- Backend auth/MCP maintainers
- Observability maintainer (for Sentry grouping/level verification)

## Notes
- This is an operational reliability/documentation issue and should be tracked through a code fix PR plus post-deploy telemetry verification.
