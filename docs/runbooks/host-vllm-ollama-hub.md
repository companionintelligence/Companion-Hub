# Host vLLM + Ollama + Hub runbook

This guide covers running **vLLM** and **Ollama** on the host while **CI Hub** and apps (including **Companion Memory / ci-memory**) run in Docker.

## Architecture

| Service | Host port | Role |
|---------|-----------|------|
| vLLM | 8000 | Chat, summaries, agents (OpenAI-compatible `/v1`) |
| Ollama | 11434 | Semantic Fingerprint embeddings only when vLLM is the chat backend |
| Hub (Docker) | — | Onboarding, settings, env injection into apps |

Hub reaches host services via `host.docker.internal` (see `docker-compose.prod.yml`: `VLLM_URL=http://host.docker.internal:8000`). A different vLLM server (custom port, or a remote machine) can be configured per-Hub via the **vLLM endpoint URL** field on the setup card — persisted as `inferenceVllmUrl`, which wins over the `VLLM_URL` env default.

## 1. Start vLLM on the host

Example (NVIDIA GPU — this model is in the Hub catalog and fits an 8 GB card with these flags):

```bash
vllm serve Qwen/Qwen3-4B-Instruct-2507 \
  --host 0.0.0.0 \
  --port 8000 \
  --quantization bitsandbytes --max-model-len 8192 --gpu-memory-utilization 0.85 \
  --api-key vllm-local
```

Verify from the host:

```bash
curl -s http://127.0.0.1:8000/v1/models -H "Authorization: Bearer vllm-local"
```

## 2. Start Ollama on the host (required for embeddings with vLLM chat)

```bash
ollama serve
ollama pull nomic-embed-text
```

Verify:

```bash
curl -s http://127.0.0.1:11434/api/tags
```

## 3. Hub onboarding / settings

1. Choose **vLLM** as the inference backend. It is always selectable — the live endpoint probe on the setup card is the gate, not the local GPU. (Hardware still drives which backend is *recommended*: NVIDIA + container GPU runtime recommends vLLM.)
2. Complete the **vLLM setup** card — Hub probes `host.docker.internal:8000/v1/models` by default, or the custom **endpoint URL** you enter.
3. Optionally enter your **vLLM API key** (must match `--api-key` on the host).
4. Complete the **Ollama embeddings** card — recommended but does not block Continue when vLLM is ready.
5. Select vLLM chat models (opens Hugging Face if not yet served) and Ollama embedding models. After loading a model in vLLM, **Re-check** refreshes both the status banner and the installed-model list.

Hub persists `inferenceBackend: "vllm"` and optional `inferenceVllmApiKey` / `inferenceVllmUrl` to `state/settings.json`.

## 4. Env injected into ci-memory

After saving preferences, Hub regenerates `app.env` and restarts AI apps:

| app.env variable | Source |
|------------------|--------|
| `LLM_API_BASE` | vLLM OpenAI URL (`…/v1`) |
| `LLM_API_KEY` | Custom key or default `vllm` |
| `LLM_DEFAULT_CHAT_MODEL` | Selected chat model |
| `OLLAMA_EMBED_HOST` | Host Ollama URL |
| `LLM_DEFAULT_EMBEDDING_MODEL` | Ollama embedding model |

**Note:** Docker applies `env_file` on **container recreate**, not `restart`. Hub's `restartAiApps()` should recreate containers after preference changes.

## 5. Verify Companion Memory

Inspect app env (path varies by install):

```bash
cat ~/.local/share/companion-hub/app-data/ci-marketplace/ci-memory/app.env | grep -E 'LLM_|OLLAMA_EMBED'
```

Expected when vLLM + Ollama are configured:

- `LLM_API_BASE=http://host.docker.internal:8000/v1` (or equivalent)
- `LLM_API_KEY=vllm-local` (or your custom key)
- `OLLAMA_EMBED_HOST=http://host.docker.internal:11434`
- `LLM_DEFAULT_EMBEDDING_MODEL=nomic-embed-text`

Recreate api + summary-service if env was patched manually:

```bash
docker compose -f … recreate api summary-service
```

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Hub cannot reach vLLM | vLLM bound to `0.0.0.0:8000`; firewall allows Docker bridge to host |
| Chat 401 | API key in Hub settings matches vLLM `--api-key` |
| Embeddings fail | Ollama running on host; `OLLAMA_EMBED_HOST` set in app.env |
| Model not in picker | Load model in vLLM, click Re-check on setup card |
| AMD GPU | Hub cannot *run* vLLM locally on AMD (no maintained ROCm image) — use Ollama, or point the endpoint URL at a vLLM server elsewhere |
| No recommended vLLM models | No curated vLLM model fits the GPU's VRAM (smallest is ~9 GB bf16); serve a quantized model manually and Re-check |

## Out of scope (this epic)

- Hub-managed `ci-hub-vllm` Docker sidecar
- Hot-swapping vLLM models from Hub
- Overriding Hub-injected LLM endpoint from CI-Server Settings UI

## Marketplace apps

All inference-opted marketplace apps declare `hub_integration.inference` in `config.json`.
See [CI-Marketplace hub inference integration](../../../ci-marketplace/docs/hub-inference-integration.md)
for profile presets (`openai_chat`, `openai_rag`, `ollama_native`) and author guidelines.
