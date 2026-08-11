# Strix Halo inference stress matrix

CI-OS only targets **AMD Strix Halo** (gfx1151). This suite measures the failure modes that matter for rolling a capable local model under Hub + ci-memory + OpenClaw/Hermes + private apps — **not** kyuz0-style tok/s saturation.

Hub already excludes dense models with **active params > 14B** on x86 APUs (`APU_MAX_ACTIVE_PARAMS_B`). The primary Strix Halo rollout is **Qwen3.6-35B-A3B AWQ MoE (~3B active)** on host vLLM (`~/bin/start-vllm-strix-halo.sh`).

## Quick start

```bash
# Against whatever is on :8000
python3 scripts/strix-halo/stress_matrix.py

# After switching to a 14B server
~/bin/start-vllm-14b.sh
python3 scripts/strix-halo/stress_matrix.py --out /tmp/strix-14b.json
```

## Phases

| Phase | What it measures |
|-------|------------------|
| `inventory` | MemAvailable, swap, docker top consumers, vLLM queue/KV |
| `context` | Tool-call accuracy at 4K / 16K / 32K / 64K prompt budgets |
| `concurrent` | Overlapping tool + JSON label + chat traffic (shared-queue contention) |
| `cliff` | Whether current `max-model-len` × util leaves headroom |
| `scorecard` | Weighted gate for 14B agent rollout |

```bash
python3 scripts/strix-halo/stress_matrix.py --phase inventory,context
```

## Scorecard weights

| Metric | Weight | Gate signal |
|--------|--------|-------------|
| Tool-call accuracy | 40% | mean pass rate across context budgets |
| Context break point | 25% | highest budget with ≥66% tool pass (Hermes wants 64K) |
| p95 latency | 20% | concurrent burst |
| Memory headroom | 15% | MemAvailable + swap |

**Rollout gate:** weighted ≥ 0.70 **and** tool ≥ 0.66 **and** stable context ≥ 16K.

## Env

| Variable | Default |
|----------|---------|
| `VLLM_BASE` | `http://127.0.0.1:8000/v1` |
| `VLLM_API_KEY` | `vllm-local` |
| `VLLM_MODEL` | first model from `/v1/models` |
| `VLLM_METRICS` | `http://127.0.0.1:8000/metrics` |

## Related

- Runbook: `docs/runbooks/strix-halo-stress-matrix.md`
- Host launcher (27B legacy): `~/bin/start-vllm-qwen35.sh`
- Host launcher (14B target): `~/bin/start-vllm-14b.sh`
- Plan HTML: `/home/ci/devel/strix-halo-inference-plan.html`
