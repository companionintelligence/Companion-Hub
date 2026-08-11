# Strix Halo stress matrix (CI-OS)

CI-OS ships for **AMD Strix Halo only**. Use this matrix when changing the host chat model or vLLM knobs (`gpu-memory-utilization`, `max-model-len`, `max-num-seqs`).

## Why not tok/s benches

Saturation benchmarks (64 concurrent seqs) do not predict OpenClaw/Hermes failure. Agents fail from:

1. **Tool-call parse errors** — especially with reasoning/thinking parsers on
2. **Context lies** — Hub/Hermes advertise 32–64K while vLLM serves 16K
3. **Shared-queue contention** — chat + HBPE labels + agents on one engine
4. **UMA cliff** — swap appears before KV metrics look “full”

## Target model class

Hub `model-registry.service.ts` sets `APU_MAX_ACTIVE_PARAMS_B = 14` for bandwidth-constrained x86 APUs. Dense 27B “fits” 125 GiB UMA but is the wrong default for agent throughput.

| Tier | Role | Suggested size | Context |
|------|------|----------------|---------|
| A | OpenClaw / Hermes | ~14B instruct/coder AWQ | 32–64K |
| B | ci-memory chat | share Tier A | 8–16K typical |
| C | HBPE / summary batch | 4B–8B or same model, thinking off | 4–8K |

## How to run

```bash
cd ~/devel/ci/ci-os-hub   # or your checkout
python3 scripts/strix-halo/stress_matrix.py --out /tmp/strix-stress.json
```

Compare candidates by restarting vLLM between runs:

```bash
~/bin/start-vllm-14b.sh          # 14B AWQ, util 0.60, ctx 65536, seqs 2
python3 scripts/strix-halo/stress_matrix.py --out /tmp/14b.json

# optional: legacy 27B for scorecard contrast
~/bin/start-vllm-qwen35.sh
python3 scripts/strix-halo/stress_matrix.py --out /tmp/27b.json
```

## Interpreting the gate

`rollout_gate_14b` is PASS only when:

- weighted score ≥ 0.70
- tool accuracy ≥ 0.66
- highest stable tool context ≥ 16K

If context phase never reaches 64K but Hermes is installed, either raise `max-model-len` (re-test cliff) or document that Hermes cannot meet its 64K floor on that config.

## Full-stack concurrent check (manual add-on)

The suite simulates overlapping request *types*. Also spot-check with real apps while the suite’s concurrent phase runs:

- OpenClaw: 10 tool turns
- Hermes: session start
- ci-memory: one chat message
- HBPE / summary: short batch if scheduled

Watch: `free -h`, `num_requests_waiting`, OOM in `dmesg`, swap growth.
