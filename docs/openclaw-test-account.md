# OpenClaw test account on the fleet

An isolated OpenClaw profile whose every model call — chat and embeddings — is routed across the
tailnet by the [fleet router](fleet-router.md). Use it to exercise agent traffic against real fleet
hardware without touching your day-to-day OpenClaw config.

This is the **no-Hub** path. When a Hub is running, wire OpenClaw to it with
`cihub connect openclaw` ([CLI.md](CLI.md#connect-an-agent)) and let Hub Pool do the routing; this
document is for a machine that cannot run one.

## Why a profile

`--profile <name>` isolates `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` under
`~/.openclaw-<name>`, so the test account cannot disturb an existing install: separate config,
separate sessions, separate memory database. Deleting the directory removes the account completely.

## Setup

OpenClaw needs a newer Node than the Hub pins in `.nvmrc`. Install and run it under one that
satisfies its engine range, or every command exits on a preinstall check.

```bash
npm install -g openclaw
openclaw --profile citest config file    # creates nothing yet; prints the path it will use
```

Start the router first — the config below is probed on write, and a closed port reads as a bad
provider:

```bash
pnpm run fleet:serve --port 5099
```

Then write the provider. `api: "openai-completions"` is the adapter, not the vendor: the router
speaks that protocol and forwards to whichever fleet node wins the ranking.

```bash
openclaw --profile citest config patch --stdin <<'EOF'
{
  "models": {
    "mode": "merge",
    "providers": {
      "ci-hub-fleet": {
        "baseUrl": "http://127.0.0.1:5099/v1",
        "api": "openai-completions",
        "apiKey": "fleet-local-no-auth",
        "models": [
          { "id": "qwen3:8b",    "name": "CI-Hub Fleet - qwen3:8b" },
          { "id": "qwen3.6:27b", "name": "CI-Hub Fleet - qwen3.6:27b" },
          { "id": "gemma3:1b",   "name": "CI-Hub Fleet - gemma3:1b" }
        ]
      },
      "ollama": {
        "baseUrl": "http://127.0.0.1:5099",
        "api": "ollama",
        "models": [{ "id": "nomic-embed-text:latest", "name": "CI-Hub Fleet - nomic-embed-text" }]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "ci-hub-fleet/qwen3:8b",
        "fallbacks": ["ci-hub-fleet/qwen3.6:27b", "ci-hub-fleet/gemma3:1b"]
      }
    }
  }
}
EOF
```

The `ollama` provider is the embeddings leg. Its `baseUrl` has **no** `/v1` — that adapter calls
`/api/embed`, which the router routes across the fleet like any other model path. Setting
`env.vars.OLLAMA_HOST` does *not* reach this code path; the provider `baseUrl` is what it reads.

## Verify

```bash
openclaw --profile citest models list                       # the fleet models, primary marked default
openclaw --profile citest infer embedding create \
  --provider ollama --model ollama/nomic-embed-text:latest --text hi --json
openclaw --profile citest agent --local -m "What is the capital of France?"
```

Each should print a matching `[route]` line in the router's output naming the node that served it.

## Pick a tool-capable model

An agent turn sends a tool payload. A model that cannot accept one answers `400`, the router
correctly declines to fail over (a genuine 4xx is the request being wrong, not the hop), and the turn
surfaces `provider rejected the request schema or tool payload`.

Verified on this fleet: **`qwen3:8b` and `qwen3.6:27b` accept tools; `gemma3:1b` does not.** Keep the
small model last in `fallbacks` — it is a useful reachability canary and a poor agent.

## Known gap: memory embeddings still call OpenAI

OpenClaw's `memory` subsystem selects the `openai` embedding provider on its own. `infer embedding
providers` reports `ollama` as `configured` once the block above is written, but `openai` stays
`selected`, and no key in `openclaw.json` changes that. With no OpenAI credit the result is a
recurring, **non-fatal** log line:

```
[memory] sync failed (session update): ... 429 ... credit_balance_exhausted
```

Agent turns complete normally — only the memory index is skipped. Explicit `infer embedding create
--provider ollama` does use the fleet, so the fleet leg itself is proven; the gap is which provider
`memory` picks.
