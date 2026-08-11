# Strix Halo host vLLM (CI-OS default path)

CI-OS targets **AMD Strix Halo** (gfx1151). Hub compose cannot ship a stable
gfx1151 ROCm vLLM image, so inference is **host-managed**:

| Piece | Value |
|-------|--------|
| Image | `kyuz0/vllm-therock-gfx1151:latest` |
| ROCm on host | `amdrocm7.13-gfx1151` + kernel with working MES |
| Starter | `~/bin/start-vllm-qwen36-moe.sh` |
| Default model | [`cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit`](https://huggingface.co/cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit) |
| Served name | `Qwen3.6-35B-A3B` |
| Why this model | 35B total / **3B active** MoE (under Hub `APU_MAX_ACTIVE_PARAMS_B=14`), **262K** native context (Hermes 64K floor), ~25 GB AWQ |

Upstream BF16: [`Qwen/Qwen3.6-35B-A3B`](https://huggingface.co/Qwen/Qwen3.6-35B-A3B). Prefer the cyankiwi AWQ on 125 G UMA — do **not** use NVFP4 (NVIDIA).

## Start

```bash
~/bin/start-vllm-qwen36-moe.sh
# wait until:
curl -s -H 'Authorization: Bearer vllm-local' http://127.0.0.1:8000/v1/models
```

Knobs: `VLLM_GPU_UTIL` (default 0.60), `VLLM_MAX_MODEL_LEN` (default 65536),
`VLLM_MAX_NUM_SEQS` (default 2).

## Point Hub apps

```
LLM_API_BASE / HERMES_OPENAI_BASE_URL / OPENAI_API_BASE
  = http://host.docker.internal:8000/v1
LLM_*_MODEL / HERMES_DEFAULT_MODEL / DEFAULT_MODEL
  = Qwen3.6-35B-A3B
API key = vllm-local
```

Hermes: keep `CI_HERMES_TOOL_CHOICE_REQUIRED=1`, `CI_HERMES_MAX_TOKENS=8192`.
With 64K+ context you can unset `CI_HERMES_MIN_CONTEXT` (restore upstream 64K floor).

## Stress / bench

```bash
~/bin/strix-halo-stress --out /tmp/strix-moe.json
# quick TTFT:
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H 'Authorization: Bearer vllm-local' -H 'Content-Type: application/json' \
  -d '{"model":"Qwen3.6-35B-A3B","messages":[{"role":"user","content":"Say hi"}],"max_tokens":8,"chat_template_kwargs":{"enable_thinking":false}}'
```

## ROCm note

core3 runs `rocm-core 7.2` + `amdrocm7.13-gfx1151` with kernel `7.0.0-28-generic`.
Keep MES firmware healthy (`~/bin/verify-strix-halo-stack.sh`) before blaming the model.
