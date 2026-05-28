# Bootstrap-endpoint integration test

End-to-end test of `/api/inference/apps/:slug/bootstrap[.env]` against a live
Hub stack with a real Ollama backend.

## What it covers

- Wire shape: JSON, dotenv, headers (`X-Hub-Bootstrap-Version`,
  `X-Hub-Managed-Keys`, `Cache-Control`).
- Error paths: unknown slug → 404, unknown version → 400.
- Idempotence + cache: identical bodies on repeated requests within the TTL.
- (When `PULL_MODEL` is set) the `endpointReady` / `llmReady` flags after
  Ollama has the model on disk.

## Run

```sh
# From repo root.
bash scripts/integration/test-bootstrap.sh

# With a real model pull (~600 MB-1 GB depending on tag).
PULL_MODEL=qwen3:0.6b bash scripts/integration/test-bootstrap.sh

# Keep the stack up after tests for iteration.
KEEP_RUNNING=1 bash scripts/integration/test-bootstrap.sh
```

## Cleanup

The script tears down the stack on exit by default (`docker compose down -v`).
Set `KEEP_RUNNING=1` to skip teardown.

## What it doesn't cover

- The marketplace install pipeline (Hub copies the wrapper scripts into the
  app's data volume). Covered by the app-lifecycle integration test in
  `src/tests/integration/`.
- Per-app wrapper behavior in CI-Hermes and CI-OpenClaw. Each sibling repo
  has its own bash test suite that runs against a fixture instead of a live
  Hub.
