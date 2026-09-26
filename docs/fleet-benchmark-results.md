# Fleet Benchmark Results — Speculative Decoding

**25 Sep 2026.** Hub no longer offers speculative inference, mlx-dspark, MTPLX, or Lucebox. This file is a dated measurement log. It is not a setup guide, and the speed numbers below are not a current Hub claim.

**Run date:** 2026-09-06 / 2026-09-07 · **Nodes measured:** 15 · **Method:** each node benchmarked by a dedicated agent, then adversarially verified by a second agent whose job was to refute it. Every number below is one a verifier reproduced from the node's own logs, or is explicitly marked unverified.

**Reading rule for this document:** where a verifier could not separate an effect from the noise floor, this report says *no measured difference* rather than quoting a ratio. Where a verifier marked a claim UNSUPPORTED, the claim appears only in [§6](#6-refuted-and-unsupported-claims), never in the results tables.

---

## 0. Nodes left dirty

**None.** All 15 nodes reported `config_left_dirty: false`, and in every case a verifier independently confirmed restoration rather than accepting the agent's word (unit-file mtimes and md5sums, unchanged PIDs and `NRestarts`, container `docker inspect` field-by-field diffs, closed scratch ports, removed drop-ins).

Residue that is harmless but should be swept, in priority order:

| Node | Residue | Action |
|---|---|---|
| beta-red | root-owned `/root/bench.py` (2319 B, mtime 21:37:39) that the agent believes it may have clobbered from another agent | Confirm no other agent needed it, then delete |
| fzzy | 12 defunct `llama-server` zombie PIDs inside the lemonade container; `/root/bench` ~156 KB; `/tmp/sw_*.log` inside container | Zombies clear on next lemonade restart; delete scratch after this report is final |
| core-7 | `/root/bench-restore` ~72 KB | Keep until this report is final — it is the only reason core-7's verification was possible — then delete |
| core-14 | `/root/bench-core14/` | Keep until final, then delete |
| beta-1 | `/root/bench/run.py` (1.4 KB) | Delete |
| beta-ms-a2 | `/root/.cache/mesa_shader_cache`, `/root/.cache/radv_builtin_shaders` from a `vulkaninfo` probe | Ignore |
| beta-max | `/root/bench2.py` — **pre-existing**, from a prior session, not this run | Leave |

---

## 1. Headline — what is now established about speculative decoding

### 1.1 Speculative decoding works on this fleet, and the win is dominated by prompt content, not by hardware

Across every node where a clean A/B was possible, the paired per-prompt ratio on a **code prompt** was 1.57x–3.65x, and the paired ratio on a **prose prompt** was between a small slowdown and no measured difference. This pattern reproduced on gfx1151 (five nodes, two engines), gfx1100, CUDA, and CPU. It is the single most robust finding in the run.

The practical consequence: **there is no single "speculative decoding uplift" number for a node.** Any scalar uplift is a property of the prompt mix used to measure it. Six independent verifiers flagged the mix-median uplift field as misleading on their node, and two flagged that the number a downstream aggregator reads (the structured `uplift` field) describes no operating mode the node actually has.

### 1.2 The gfx1151 "acceptance collapse" is not a hardware defect

This is the most important correction to the fleet record. See [§4](#4-the-gfx1151-acceptance-collapse) for the full evidence chain. In summary:

- The fleet's "12.8% acceptance on gfx1151" figure was **found verbatim in the pre-session lucebox logs of three separate gfx1151 nodes** (fzzy, core-17, beta-max) as a single prose generation — `accepted=187/1456 (12.8%) avg_commit=3.04`, 277 tokens. It is one prose request, not a hardware characterisation.
- On the *same box*, with unchanged target, drafter, build and config, acceptance ranges **16.0% (prose) to 82.9% (structured JSON)** purely with prompt content (beta-max, six prompt types).
- The gfx1151 and gfx1100 numbers **are not the same metric**. gfx1151 lucebox builds report `accepted_tree_nodes / (steps × 16)`; the gfx1100 build (beta-1) reports `accepted / emitted`, which is algebraically `1 − 1/avg_commit`. Comparing 12.8% against 72% compares two different denominators.
- On the one build-independent quantity — **avg_commit, tokens committed per target forward** — gfx1151 matches or beats gfx1100 on all four shared prompts (see [§3.2](#32-gfx1151-vs-gfx1100-the-controlled-contrast)).

**Status: the acceptance-collapse hypothesis is not supported by any data gathered in this run.** It is not yet formally *refuted* — see [§4.3](#43-what-is-still-open) for the one experiment that would close it.

### 1.3 Ollama is speculative-decoding capable, and on several nodes it is already on by default

The fleet record held that only lucebox / lemonade / mlx-dspark / MTPLX / vLLM were spec-capable. That is wrong for recent ollama builds, confirmed independently on four nodes from runner argv in the journal:

- **ollama 0.32.3** (core-1), **0.32.1** (beta-red), **0.30.8** (beta-ms-a2), **0.33.3** (everxr-01, no HTTP toggle) all ship a llama-server supporting `--spec-type draft-mtp`.
- On **beta-ms-a2** it is **already enabled by default** for `qwen3.8:27b` — the runner cmdline carries `--spec-type draft-mtp --spec-draft-n-max 4 --spec-draft-backend-sampling`. The uplift there is banked, not available. Turning MTP *off* would cost that node ~42% of its 27B throughput.
- The mechanism is the model's own **MTP / NextN head** (`qwen35.nextn_predict_layers=1`, `blk.64.nextn.*` tensors), not a separate drafter. No draft model needs to be paired.
- An undocumented per-request option `draft_num_predict` maps to `--spec-draft-n-max`, confirmed behaviourally on core-1 (six requested depths appear one-for-one in runner argv) and on beta-red with a proper negative control (a bogus option name logs `invalid option provided`; `draft_num_predict` does not).

**Every ollama node currently recorded as "not spec-capable" should be re-checked by version.**

### 1.4 Lemonade's shipped speculative model is inert

`Qwen3-1.7B-spec2` as shipped performs **no speculation at all** (fzzy, verified three independent ways: llama.cpp b10707 defaults `--spec-type` to `none`; lemonade's `user_models.json` defines only `{main, draft}` checkpoints with no spec-type knob; the live managed `llama-server` process carries no `--spec-type`). The drafter is loaded into memory on every swap and never drafts a token. **Any "lemonade spec decode" figure in the fleet record measures a plain model plus a wasted drafter load and must be withdrawn.** This needs a lemonade-side fix — `--model-draft` is on their reserved-argument list.

### 1.5 The "drafter must be ~10x faster than the target" rule of thumb is refuted

razer is a clean counterexample: a 0.6B drafter running ~5.5x the target's rate, 42.8% acceptance, delivered a reproducible ~1.4x uplift on an interleaved, warm-up-excluded, flag-matched A/B. Two unraised caveats both strengthen the refutation (the drafter was benchmarked under different flags on an otherwise-empty GPU, so its true in-loop advantage is *below* 5.5x). One clean counterexample is enough to refute "~10x" as a hard requirement.

### 1.6 Speculative decoding is **not** output-lossless on the lucebox/dflash builds

Three verifiers found this independently, and none of the three original reports mentioned it:

- **core-7**: at temperature 0, drafter-ON and drafter-OFF produce different text on P1 (81 tok / 444 ch vs 74 tok / 407 ch), P3 (630 vs 658 ch) and P4 (697 vs 686 ch). Only P2 matched. Divergence is deterministic within each arm.
- **core-14**: same pattern by output hash — P1 matched, P2/P3/P4 diverged, each arm internally deterministic.
- **liam-mbp**: every one of the 12 P1 and P4 mlx-dspark race records carries `"identical": false`, with differing token counts on P4 (131 vs 132).

Consequence: on those builds, three of four paired ratios compare throughput over *different generated sequences*, and output-hash equality cannot be used as a correctness gate. This is a correctness finding independent of performance and deserves its own investigation.

**Related:** on fzzy, lucebox's plain autoregressive path is **nondeterministic against itself** at temperature 0 (P1 baseline produced 81 tokens on rep 1 and 73 on reps 2–3, same prompt, same server). That is a larger flag than the spec-vs-AR divergence.

### 1.7 On ollama, enabling spec decode can silently reduce GPU offload

On **beta-red** (RTX 3080 10 GB), every baseline launch offloaded 29/66 layers; every spec launch offloaded only 25/66 (`CUDA0 6234.88 MiB` / `CUDA_Host 8805.49 MiB` vs `7097.05` / `7943.32`). Enabling spec moved 862 MiB — four transformer layers — onto the CPU, the node's own bottleneck. **beta-nas** shows the same suspected mechanism (the ON arm's extra draft context on a VRAM-saturated 8 GiB card). On a card where the target does not fit, `draft_num_predict` therefore buys you both a drafter and a worse layer split, and the two effects cannot be separated from either node's data.

---

## 2. Speculative-decode results table

Ratios are **paired per prompt**, spec-on / spec-off on the same prompt, never pooled. `nmd` = no measured difference (effect inside the applicable noise floor). Prompt roles are the fleet's fixed mix: **P1 prose, P2 code, P3 prose, P4 list/structured**.

### 2.1 Nodes where speculative decoding was measured

| Node | Hardware | Backend / engine | Target | Drafter | P1 (prose) | P2 (code) | P3 (prose) | P4 (list) | Acceptance | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| **core-1** | gfx1151 Strix Halo / 8060S, **Vulkan** | ollama 0.32.3 | qwen3.6:27b | built-in MTP head | 2.41 | 2.72 | 1.98 | 2.02 | 69.4% (410/591) @ depth 3; code 92.1%; per-position 0.843 / 0.706 / 0.533 | **Strongest uplift in the fleet.** 12/12 paired ratios in [1.98, 2.73], none near 1.0, against a respawn-inclusive noise floor of 0.02–0.90%. Arms alternated ON/OFF ×3 in 4m13s on the same model hash; off-arm argv genuinely lacks the spec flags |
| **beta-ms-a2** | Ryzen 9 9955HX, **CPU-only** (89.6 GB/s DDR5) | ollama 0.30.8, MTP **on by default** | qwen3.8:27b | built-in MTP head | 1.62 | 1.95 | 1.68 | 1.75 | ~55% (49.3 / 64.8 / 53.2 / 55.6%) | **Real, ~1.7x** (median of paired ratios 1.71). Zero overlap between arms (min ON 5.161 > max OFF 3.205). Physically cross-checked: 3.20 tok/s = 60% of theoretical bandwidth, 5.59 tok/s = 105% — impossible without validating multiple tokens per weight pass. Interleaving self-reported only (evidence deleted) |
| **beta-1** | **gfx1100**, 2× RX 7900 XTX (only one visible to lucebox) | lucebox / dflash DDTree | Qwen3.6-27B-Q4_K_M | dflash-draft-3.6-q4_k_m | 1.43 | 3.65 | 1.46 | 1.64 | avg_commit 3.52 / 8.89 / 3.56 / 4.00 (see §4.1 on the "72%" figure) | **Real and large.** Weakest ratio is ~108x the within-arm noise spread (0.3–0.4%). Spec arm reproduces from the container log to the millisecond |
| **razer** | RTX 4080 **Laptop** 12282 MiB, CUDA | vLLM 0.28.0, `draft_model`, k=3 | Qwen3-4B-Instruct-2507 | Qwen3-0.6B | 1.52 | 1.86 | 1.13 | 1.28 | **42.8% (1680/3924 draft tokens)** — the only node reporting a true accepted/**proposed** rate | **Real, ~1.4x.** Interleaving confirmed from journal launch timestamps (B→M→B→M); both arms byte-identical parsed flags except `speculative_config`; OFF arm logs `speculative_config=None` |
| **fzzy** | gfx1151, ROCm 7.2.4 | lucebox / dflash DDTree (budget 22) | Qwen3.6-27B | dflash-draft-3.6 | **nmd** (0.958 is inside the 1.054 worst-case noise) | 2.42 | 1.07 *(edge of resolution)* | 1.22 | 16.0 / 56.6 / 18.8 / 22.5% | P2 and P4 real. P2 independently corroborated against an unhandicapped reference (ollama does 12.34–12.59 tok/s on the same model, same box) |
| **core-7** | gfx1151 | lucebox / dflash DDTree (budget 22) | Qwen3.6-27B | dflash-draft-3.6 | **unresolved** (~0.95, n=2 after warm-up exclusion) | 2.42 | **unresolved** (~1.06) | 1.20 | 16.0 / 56.6 / 18.8 / 22.5% | P2 and P4 real. Baseline is exceptionally clean — median 11.70 tok/s on **all four** prompts. Break-even ~3.7 committed tokens/step |
| **core-14** | gfx1151 | lucebox / dflash DDTree (budget 22) | Qwen3.6-27B | dflash-draft-3.6 | 0.94–0.95 *(direction reliable, ~4–5% slowdown)* | 2.37 | **nmd** (4.3% is inside 2.6–4.5% block drift) | 1.18 | 16.03 / 56.64 / 18.75 / 22.50% | P2 and P4 real. Arm order **not counterbalanced** (spec always first) with monotonic upward drift, so P1 is inflated and P3/P4 deflated |
| **core-17** | gfx1151 | lucebox / dflash DDTree | Qwen3.6-27B | dflash-draft-3.6 | 0.951 *(real ~5% slowdown, zero overlap over 3 reps)* | 2.52 | **nmd** (1.049) | 1.19 | 16.0% (prose) → 66.1% (JSON) by content | **Best-verified interleave in the fleet.** Reconstructed from the untouched production container's own timestamps: all 11 idle gaps fit exactly one interleaved baseline request of the matching prompt, to within 0.3 s |
| **beta-max** | gfx1151 | lucebox / dflash DDTree (budget 22) | Qwen3.6-27B-Q4_K_M (16.82 GB) | dflash-draft-3.6 (1.06 GB) | 0.94 | 2.40 | 1.05 | 1.19 | **6.2% → 82.9%** by content: prose 16.0–18.8, list 22.5, code 55.5–63.4, markdown table 75.9, JSON 82.9 | All four outside a true within-cell noise of 1.005–1.015x. Rep-1 P1 (9.30) discarded as cold — the 3-token warm-up was inadequate |
| **beta-nas** | RTX A1000 8188 MiB, CUDA | llama-server (manual), MTP | qwen3.6:27b (17.42 GB, **20/66 layers on GPU**) | built-in MTP head | 0.976 **confounded** | **1.574** | 0.940 **confounded** | 1.095 **confounded** | 28.25% (21.8 / 53.3 / 18.7 / 27.2%) | **Only P2 survives.** Reproduced identically in both cycles; counters internally consistent with n_max=3 (165/3=55 iters + 88 = 143 ≈ predicted_n 144). The other three are n=2 per cell with an unreported VRAM/layer-split confound the agent measured and did not publish |
| **beta-red** | RTX 3080 **10 GB**, CUDA | ollama 0.32.1, `draft_num_predict` | qwen3.6:27b (**29/66 layers**) | built-in MTP head | 0.555 | 0.812 | 0.526 | 0.583 | 22.66% (261/1152) | **Slowdown is real and user-visible but the mechanism is NOT established.** The spec arm also ran 25/66 layers instead of 29/66 — 862 MiB more on the CPU. Honest claim: *setting `draft_num_predict` on beta-red makes generation ~1.76x slower because ollama both enables MTP self-draft and reduces GPU offload; the two cannot be separated.* Operational advice (leave it off) stands |
| **fzzy** (2nd expt) | gfx1151 | llama.cpp `draft-simple` | Qwen3-1.7B | Qwen3-0.6B | 0.65 | 0.95 | — | 0.69 | 74% @ n_max=3 | **Real slowdown, median paired ratio 0.664**, 4 interleaved reps, far outside a ~1.05 floor, outputs byte-identical. **No draft depth rescues it** — every sweep point (46–81 tok/s) is below the ~84 tok/s baseline. Cause is drafter forward-pass latency against a small target, not poor acceptance |
| **liam-mbp** | Apple M2 Max, 38 GPU cores, 96 GB | mlx-dspark `/admin/race` | LFM2.5-1.2B-Instruct-MLX-bf16 | LFM2.5-1.2B-Instruct-DSpark | 0.744 | 0.863 | 0.806 | 0.643 | accept_len 2.11–2.73 (healthy) | **Slowdown on the path measured — but the path is a diagnostic endpoint that bypasses the prefix cache.** 24/24 retained paired ratios below 1.0, in both arm orders, both load regimes. dspark vs baseline was **never A/B'd on the serving path**. Node was contended throughout |
| **liam-mbp** | Apple M2 Max | MTPLX `generation_mode` toggle | (MTPLX default) | MTP | 1.15 | 1.08 | 0.84 | straddles 1.0 | per-arm `draft_n` 81/155/213/191, accept_rate present on mtp arms only | **Prompt-dependent, +15% to −16%, underpowered** (n=3 effect, n=2 control per prompt). Only P3 clears its own control band, and it is a *slowdown*. Toggle verified real (`mode_echo` mtpk/ar, draft_n 0 on ar arms) |

### 2.2 Nodes where speculative decoding was untestable — with the blocker

A documented blocker is a result. Each of these should be re-tested when its blocker is cleared.

| Node | Hardware | Backend | Blocker | What would unblock it |
|---|---|---|---|---|
| **ci** | gfx1151, ROCm 10.0.0-4 | ollama **0.24.0** | ollama 0.24.0's draft path is **Apple-MLX-only** (all 1026 draft/speculative symbols live under `x/mlxrunner`) *and* requires safetensors (`"draft models are only supported for safetensors LLM models"`); both local models are GGUF. No spec-capable listener, no lemonade/lucebox/vLLM/MTPLX unit | Upgrade ollama to ≥0.30 and pull an MTP-carrying model |
| **core-4** | unknown (SSH refused, hardware endpoints 401) | ollama 0.16.1 + CI-Hub 0.2.47 | Only two models on disk (`gemma3:1b`, `nomic-embed-text`) so no target/draft pair; `vllm` and `lemonade` both `running:false`; all ten alternative engine ports closed; ollama 0.16.1 has no draft-model parameter. **Also: GPU offload is broken** — default options return HTTP 500 | Fix the GPU init fault first; the node currently serves nothing to a default client |
| **everxr-01** | Windows, discrete GPU, part unknown | ollama 0.33.3 | No shell (port 22 and WinRM 5985 closed — Tailscale SSH is Linux/macOS only). ollama 0.33.3 exposes **no HTTP drafter toggle**: all 11 option syntaxes were silently discarded (`load_ms` 2–3 ms, no runner rebuild) | An HTTP-reachable toggle, or a Windows remote-exec path |
| **core-7** (lemonade) | gfx1151 | lemonade :13305 | Exactly one model on disk (`Qwen3-0.6B-GGUF`, 365 MB). No target/drafter pair exists | Download a target model — needs a storage-policy owner decision |
| **core-17** (lemonade) | gfx1151 | lemonade :13305 | One model, no `--model-draft`/`-md`/`--draft` in the live launch command | Same |
| **beta-max** (lemonade) | gfx1151 | lemonade :13305 | One model, `max_models.llm = 1` | Same |
| **core-14** (lemonade) | gfx1151 | lemonade :13305 | No drafter configured; `--temp 0.6 --top-p 0.85 --top-k 20` baked into the launch command, so it is not even deterministic at temperature 0 | Same, plus a determinism fix before any A/B |
| **fzzy** (lemonade) | gfx1151 | lemonade :13305 | **`Qwen3-1.7B-spec2` is inert** — see §1.4. Not a missing-model blocker; a shipped-config defect | lemonade-side fix to pass `--spec-type` |
| **everxr-01** (`gemma4-26b-think`) | — | ollama | MoE (`expert_count=128`, `expert_used_count=8`), so unusable as a dense same-size control | n/a — recorded so nobody reuses it as one |
| **beta-ms-a2** (`qwen3.6:latest`) | CPU | ollama | 35B-A3B MoE with no MTP head — `common_speculative_init: no implementations specified` | n/a |

---

## 3. Same-hardware comparisons

### 3.1 Seven gfx1151 Strix Halo nodes — a genuine controlled comparison

The fleet has **seven** gfx1151 / Radeon 8060S nodes, not six: **core-1, ci, fzzy, core-7, core-14, core-17, beta-max**. All are AMD Ryzen AI MAX+ 395 with the same iGPU, ~96–103 GiB GPU-visible unified memory, and the same 512 MiB VRAM carve-out reporting quirk. Five ran the identical lucebox stack (Qwen3.6-27B-Q4_K_M + `dflash-draft-3.6-q4_k_m`, DDTree, budget 22, q8_0 KV) against the identical four-prompt mix. **That is a five-way replication under near-identical conditions**, and it is the most valuable structural asset in this dataset.

**Five-node gfx1151 lucebox replication:**

| Node | Baseline (drafter OFF) | P1 prose | P2 code | P3 prose | P4 list | Acceptance (P1/P2/P3/P4) |
|---|---|---|---|---|---|---|
| fzzy | ~11.3–11.8 tok/s | nmd | 2.42 | 1.07 | 1.22 | 16.0 / 56.6 / 18.8 / 22.5% |
| core-7 | 11.70 (all four prompts) | unresolved | 2.42 | unresolved | 1.20 | 16.03 / 56.64 / 18.75 / 22.50% |
| core-14 | 11.5–11.9 | 0.94–0.95 | 2.37 | nmd | 1.18 | 16.03 / 56.64 / 18.75 / 22.50% |
| core-17 | 10.83–11.06 | 0.951 | 2.52 | nmd | 1.19 | 16.0 … 66.1% by content |
| beta-max | 11.3–11.4 | 0.94 | 2.40 | 1.05 | 1.19 | 16.0 / 55.5–63.4 / 18.8 / 22.5% |

**What the controlled data supports:**

1. **The result replicates across five independent boxes.** P2 lands in 2.37–2.52, P4 in 1.18–1.22, P1 in 0.94–0.96, P3 in 1.04–1.07. Given each node has n=2–4 per cell, the between-node spread is about the size of a single node's own block-to-block drift. The effect is a property of the stack, not of any one machine.
2. **Acceptance is bit-identical across boxes.** `0.16032609343528748` and `0.56640625` appear to 17 decimals on core-7 *and* core-14, and the same four values appear on fzzy. Acceptance on this engine is a deterministic function of the prompt — which also means it can never be used to discriminate between hardware or between config knobs on the same prompt.
3. **The baseline is remarkably flat and content-independent.** core-7's drafter-OFF arm gives median 11.70 tok/s on all four prompts. Whatever varies with content, it is the drafter, not the target.
4. **P1 (prose) is a slowdown on this stack**, of the order of 4–6%. Three of five nodes resolve it as real; two cannot resolve it at their sample size. No node measured it as a speedup.
5. **P3 (prose) is not resolvable.** Three of five verifiers reduced it to *no measured difference*. Do not carry ~1.05x forward.
6. **Two config knobs claimed inert are actually unverified.** `--ddtree-budget` (core-7, core-14, beta-max) and `DFLASH27B_DRAFT_SWA` (core-14) both produced bit-identical results across the change — which is equally the signature of the setting never reaching the engine. Only core-14's budget sweep confirmed the knob took effect at startup (six budgets 2→32, all bit-identical acceptance *and* output hash); the SWA arm never did. See §6.
7. **Vulkan vs ROCm on gfx1151 does not have one answer.** ci measures ROCm **3–4% faster** than Vulkan on qwen3:8b decode (4/4 per-prompt ratios below 1.0, zero raw-sample overlap on every prompt). fzzy measures Vulkan **~3% faster on decode but ~3.6x slower on prefill**, so ROCm wins wall-clock there too. **Neither reproduces the recorded "Vulkan is ~30% faster than ROCm on core-1".** core-1 was measured on Vulkan only this run — no paired Vulkan/ROCm arm was taken there — so the 30% figure is neither confirmed nor refuted, and must be re-measured paired before anyone relies on it. Standing guidance ("do not fix a Vulkan config into ROCm") does not hold on ci or fzzy.

**What the controlled data does not support:** ranking the gfx1151 nodes against each other on speed. Their baselines span 10.83–11.90 tok/s, a range comparable to the block-to-block drift measured within single nodes (2.6–4.5% on core-14), and no node ran a cross-node control.

### 3.2 gfx1151 vs gfx1100 — the controlled contrast

**beta-1** is the fleet's only gfx1100 node (2× RX 7900 XTX, of which lucebox sees one, shared with the GNOME desktop compositor). It runs the **same target and the same drafter filename** as the five gfx1151 lucebox nodes — `Qwen3.6-27B-Q4_K_M` + `dflash-draft-3.6-q4_k_m.gguf` — against the same four-prompt mix. That makes it the natural contrast.

| | gfx1151 (5 nodes, lucebox) | gfx1100 / beta-1 (lucebox) |
|---|---|---|
| Baseline, drafter OFF | 10.83–11.90 tok/s | 29.3–29.6 tok/s (**~2.6x faster**) |
| P1 prose paired ratio | 0.94–0.96 | **1.43** |
| P2 code paired ratio | 2.37–2.52 | **3.65** |
| P3 prose paired ratio | 1.04–1.07 (mostly nmd) | **1.46** |
| P4 list paired ratio | 1.18–1.22 | **1.64** |
| avg_commit P1 / P2 / P3 / P4 | 3.52 / 10.00 / 4.00 / 4.57 | 3.52 / 8.89 / 3.56 / 4.00 |
| Reported "acceptance" | 16.0 / 56.6 / 18.8 / 22.5% | 71.6 / 88.8 / 71.9 / 75.0% |
| Denominator of that figure | `accepted / (steps × 16)` | `accepted / emitted` = `1 − 1/avg_commit` |
| lucebox image | `:rocm-7.2` | `:rocm` |

**Three things this table establishes:**

1. **gfx1151's drafter is not worse than gfx1100's — on the build-independent metric it is equal or better on all four prompts.** avg_commit on the prose prompt is 3.52 on both architectures, to three significant figures. This is the single cleanest piece of evidence against the acceptance-collapse hypothesis.
2. **The apparent 12.8% vs 72% gap is a denominator artifact, not a hardware gap.** Applying gfx1100's own formula to gfx1151's P1 (avg_commit 3.52) gives `1 − 1/3.52 = 71.6%` — exactly beta-1's P1 figure.
3. **gfx1100 nonetheless converts the same drafting into a much larger uplift.** Why is mechanistic, and core-7's per-step cost model explains it: on gfx1151, speculative-step fixed overhead is ~293 ms against an 85.5 ms baseline token — **3.43 target forwards of pure overhead per step**, giving a break-even of ~3.7 committed tokens per step. gfx1151's prose prompts sit at avg_commit 3.52–4.00, i.e. *right on the break-even line*, which is exactly why P1 is a small loss and P3 is unresolvable. gfx1100's baseline token is ~2.6x cheaper, so the same avg_commit clears its break-even comfortably. **The gfx1151 problem is per-step overhead, not acceptance.**

**Caveats that must travel with this comparison:** the two sides ran different lucebox image tags (`:rocm-7.2` vs `:rocm`), whose acceptance-reporting code demonstrably differs; no single agent ran both architectures; and beta-1's reported accept_rate field is a raw *count*, not a rate.

### 3.3 Ollama MTP self-drafting, across four architectures

Where ollama's built-in MTP head could be exercised, the target's fit in VRAM dominates the outcome:

| Node | Architecture | Target fits? | Result |
|---|---|---|---|
| core-1 | gfx1151 / Vulkan, 111 GiB GPU-visible | Yes, 66/66 layers both arms | **2.0–2.7x** |
| beta-ms-a2 | CPU-only, 89 GiB | n/a (CPU) | **~1.7x** |
| beta-nas | RTX A1000 8 GiB, 20/66 layers | **No** | 1.57x on code only; other prompts confounded |
| beta-red | RTX 3080 10 GB, 29/66 layers | **No** | **~0.57x** — and the spec arm also lost 4 GPU layers |

This is suggestive of "target must fit for MTP to pay off", but **it cannot be claimed** from this data: both partial-fit nodes have an arm-correlated layer-split confound, so the hypothesis and the confound are perfectly collinear. See §8 for the experiment that would separate them.

---

## 4. The gfx1151 acceptance collapse

### 4.1 Every piece of evidence gathered

**A. The 12.8% figure was located, and it is one prose request.**
The exact line `[spec-decode] ... accepted=187/1456 (12.8%) avg_commit=3.04` was found verbatim in the pre-session lucebox container logs of **three separate gfx1151 nodes**:
- **beta-max** — at `2026-09-07T03:29:49`, the **first request ever made to that container** (created 03:26:27, `RestartCount=0`), a 277-token generation.
- **core-17** — at `2026-09-07T03:29:19`, and it is the **only** spec-decode line before the session.
- **fzzy** — present verbatim in `docker logs lucebox-hub`, 1456 draft tokens over 91 steps.

It is a single prose generation on a freshly-provisioned container, reproduced independently on three boxes. It was never a hardware measurement.

**B. It was also misattributed.** The line lives in the **lucebox** log, not lemonade's. core-17 confirmed lemonade structurally cannot have produced it: its live launch command is `llama-server -m Qwen3-0.6B-Q4_0.gguf --ctx-size 40960 --port 8001 --jinja --metrics --temp 0.6 ... --parallel 1`, with no `--model-draft`/`-md`/`--draft`, and only one model on disk.

**C. Acceptance on one gfx1151 box spans 6.2%–82.9% with prompt content alone.** beta-max, same container, same target and drafter, same `ddtree_budget 22`, no restart between measurements: prose 16.0–18.8%, list 22.5%, code 55.5–63.4%, markdown table 75.9%, JSON 82.9%. core-17 independently measured 16.0% → 66.1% on the same box. **A 3.5x–5x swing on fixed hardware.**

**D. The metric is algebraically degenerate on the `:rocm-7.2` builds.** In every one of the 22 logged requests core-17 examined, `proposals = steps × 16` exactly (368/23, 256/16, 640/40, 560/35, 1456/91 …), and `accepted = tokens − steps ± 1`. So the reported percentage reduces to **`(avg_commit − 1) / 16`** — a pure restatement of commits-per-step, i.e. of how predictable the text is. core-7 corroborated this independently from raw JSONL (`59/368`, `145/256`, `120/640`, `126/560` all satisfy `accepted/(steps×16)`). It is **not** a classical accepted/proposed acceptance rate, and it is structurally capped at 1/16 per unaccepted node.

**E. The gfx1100 figure uses a different denominator.** beta-1's 72%/77.6% is `accepted / emitted`, algebraically `1 − 1/avg_commit`. The engine never logs a proposal count on that build, so the true accepted/proposed rate on gfx1100 **is not recoverable from any data gathered**. Its own log also prints a hardcoded `/1` denominator (`accepted=142/1 (14200.0%)`), and the API's `usage.accept_rate` field is a **raw count, not a rate** — anyone consuming it as a percentage will corrupt fleet numbers.

**F. On the common metric, gfx1151 matches or beats gfx1100.** avg_commit per prompt: 3.52 / 10.00 / 4.00 / 4.57 (gfx1151) vs 3.52 / 8.89 / 3.56 / 4.00 (gfx1100).

**G. Acceptance decays steeply and monotonically with draft depth**, measured two independent ways:
- **core-1** (ollama MTP, qwen3.6:27b, gfx1151/Vulkan), cumulative: **91.0% d1 · 88.8% d2 · 77.9% d3 · 75.9% d4 · 58.4% d6 · 43.6% d8**, with the d8 per-position curve 0.832 / 0.644 / 0.505 / 0.406 / 0.356 / 0.277 / 0.218 / **0.178**. Every figure reproduced verbatim from the journal.
- **fzzy** (llama.cpp `draft-simple`, 1.7B target + 0.6B drafter): **0.859 at n_max=1 → 0.351 at n_max=16**, verified verbatim in `sweep2.log`.

The general lesson: **a pooled scalar acceptance number cannot distinguish "bad drafter" from "good drafter run too deep".** Every acceptance figure in the fleet record must carry its prompt, its draft depth, and its denominator, or it is uninterpretable.

**H. Two other spec-capable architectures land inside the gfx1151 content range**, which weakens any "gfx1151 is anomalous" reading: razer/CUDA at 42.8% (true proposed denominator, k=3) and beta-ms-a2/CPU at ~55%. Neither is a controlled comparison, and neither should be cited as one.

### 4.2 What is now known

1. The 12.8% figure is a **single prose generation on a gfx1151 lucebox container**, reproduced on three nodes, not a hardware characterisation.
2. On gfx1151, with the shipped config, acceptance is **prompt-dominated**, spanning 6.2%–82.9% on one unchanged box.
3. The gfx1151 and gfx1100 figures are **different metrics with different denominators** and were never comparable.
4. On the shared, build-independent metric (avg_commit), gfx1151 is **equal or better than gfx1100 on all four prompts**.
5. gfx1151's real problem is **per-step overhead, not acceptance**: ~293 ms fixed cost = 3.43 target forwards, break-even ~3.7 committed tokens/step, and its prose prompts sit at 3.52–4.00.
6. **gfx1151 silicon is not intrinsically incapable of high draft acceptance** — core-1 reached 69.4% cumulative and 92.1% on code with a jointly-trained MTP head under ollama.

### 4.3 What is still open

- **No gfx1100 measurement was taken with the gfx1151 prompt mix under a matched build.** Every cross-architecture statement above rests on avg_commit reconciliation, not on a run somebody controlled end to end.
- **The true accepted/proposed rate on gfx1100 is unknown** — beta-1's build does not log proposals, and `ddtree_budget=22` means the proposal count is not `steps × 16` there.
- **The `/1` denominator bug's blast radius is unmapped.** It was demonstrated for `ghcr.io/luce-org/lucebox-hub:rocm` on one node. Note its direction: a count read as a percentage *inflates*, so it cannot by itself explain a figure as low as 12.8%.

**Verdict to record: the acceptance-collapse hypothesis is unsupported by all evidence gathered, and the specific 12.8%-vs-72% comparison that generated it is invalid. Do not record it as refuted until §8's experiment 1 runs.**

---

## 5. Throughput across the fleet

Absolute tok/s. **Per-prompt ranges are given wherever the verifier recovered them**, because on several nodes the pooled range is bimodal and describes no operating mode. `n` is the reported sample count. Everything below is a figure a verifier recomputed from the raw samples.

### 5.1 Qwen3.6/3.8-27B class

| Node | Hardware / placement | Engine | Config | Median | Min–Max | n | Notes |
|---|---|---|---|---|---|---|---|
| beta-1 | gfx1100, full GPU | lucebox | drafter OFF | 29.4 | 29.3–29.6 | 12 | Per-prompt: 29.6 / 29.4 / 29.3 / 29.3 |
| beta-1 | gfx1100 | lucebox | drafter ON | — | P1 42.4 · P2 107.3 · P3 42.9 · P4 48.2 | 12 | Noise floor 0.3–0.4%. Pooled range would be meaningless |
| core-1 | gfx1151 Vulkan, 66/66 | ollama 0.32.3 | spec OFF | 13.025 | 13.014–13.118 | 12 | Within-arm spread 0.02–0.90%, respawn-inclusive |
| core-1 | gfx1151 Vulkan, 66/66 | ollama 0.32.3 | spec ON (d3) | 29.004 | 25.801–35.565 | 12 | **Pooled across prompts** — bimodal, quote per-arm not per-node |
| fzzy | gfx1151 ROCm | lucebox | drafter OFF | ~11.55 | 11.3–11.8 | 12 | |
| fzzy | gfx1151 ROCm | lucebox | drafter ON | — | P2 26.9–28.3 | 12 | |
| fzzy | gfx1151 ROCm | ollama | plain AR | ~12.44 | 12.34–12.59 | — | Independent unhandicapped reference for the lucebox P2 result |
| core-7 | gfx1151 | lucebox | drafter OFF | **11.70 on all four prompts** | 11.3–11.9 | 12 | Unusually clean control |
| core-7 | gfx1151 | lucebox | drafter ON | — | P1 ~11.2 · P2 28.27 · P3 12.43 · P4 14.07 | 24 | Published pooled range 10.7–28.4 is the prose/code gap, not a spread |
| core-14 | gfx1151 | lucebox | drafter OFF | ~11.7 | 11.5–11.9 | 8 | Block-to-block drift 2.6–4.5% |
| core-14 | gfx1151 | lucebox | drafter ON | — | P1 10.8–11.2 · P2 27.2–28.1 · P3 ~12.1 · P4 ~13.6 | 8 | |
| core-17 | gfx1151 | lucebox | drafter OFF | ~10.9 | 10.83–11.06 | 12 | |
| core-17 | gfx1151 | lucebox | drafter ON | — | P1 10.30 · P2 27.78 (pooled 10.304–27.784) | 12 | Server-side `speed=` corroborates client-side to 1–6% |
| beta-max | gfx1151 | lucebox | drafter OFF | ~11.35 | 11.3–11.4 | 16 | |
| beta-max | gfx1151 | lucebox | drafter ON | — | P1 10.59–10.75 · P2 27.02–27.14 · P3 11.81–11.89 · P4 13.27–13.45 | 16 | Rep-1 P1 (9.30) discarded as cold |
| beta-ms-a2 | CPU-only (DDR5-5600 ×2) | ollama 0.30.8 | MTP ON (default) | 5.5935 | 5.147–6.251 | 12 | P2 fastest at ~6.2 |
| beta-ms-a2 | CPU-only | ollama 0.30.8 | MTP OFF | 3.202 | 3.193–3.205 | 12 | 60% of 89.6 GB/s theoretical peak — textbook CPU llama.cpp |
| beta-nas | RTX A1000, **20/66 layers** | ollama 0.32.1 | default (no drafter) | 4.5635 | 4.478–4.612 | 12 | Per-prompt 4.588 / 4.516 / 4.513 / 4.566. **CPU-bound number on a box with a GPU** |
| beta-red | RTX 3080 10 GB, **29/66 layers** | ollama 0.32.1 | default | 3.224 | 3.192–3.287 | 24 | Per-prompt 3.246 / 3.205 / 3.208 / 3.207 — prefer these to the pooled range. Two runs 40 min apart agree within 0.7% |
| beta-red | RTX 3080, **25/66 layers** | ollama 0.32.1 | spec ON | 1.821 | — | 12 | Confounded arm; see §2.1 |
| everxr-01 | Windows, GPU part unknown, 100% offload | ollama 0.33.3 | default (MTP status unproven) | — | P1 89.71 · P2 132.65 · P3 94.19 · P4 94.19 | 28 | Noise floor 1.023x. **Content-dependent — pooled median 94.19 hides the whole finding** |

### 5.2 Smaller models

| Node | Model | Engine | Median | Min–Max | n | Notes |
|---|---|---|---|---|---|---|
| core-1 | qwen3:8b | ollama 0.32.3 Vulkan | 41.763 | 41.581–42.378 | 12 | 1.9% spread; no drafter available |
| ci | qwen3:8b | ollama 0.24.0 **ROCm** | 39.24 | 39.06–40.15 | 20 | Per-prompt 39.37 / 39.11 / 40.09 / 39.09 |
| ci | qwen3:8b | ollama 0.24.0 **Vulkan** | — | ~3–4% below ROCm | 16 | Per-prompt deficits 3.14 / 3.32 / 4.98 / 3.46%; the two length-matched prompts give 3.32% and 3.46% |
| ci | gemma3:4b | ollama ROCm | 68.98 | 68.61–69.72 | 20 | Ran at KvSize 65536 vs qwen3's 40960 — **not** a controlled cross-model comparison |
| everxr-01 | qwen3-vl:8b | ollama 0.33.3 | 155.12 | P1 155.03 · P2 155.26 · P3 154.82 · P4 155.07 | 28 | Genuinely flat (1.003x) — the control that makes the 27B finding interpretable |
| beta-ms-a2 | qwen3.6:latest (35B-A3B MoE) | ollama 0.30.8 | 19.6935 | 19.604–19.791 | 12 | Prompt identity barely matters (<0.5%) |
| core-7 | Qwen3-0.6B-Q4_0 | lemonade ROCm | 263.02 | 256.43–264.75 | 12 | Per-prompt spreads uneven: P2 0.6%, P4 0.1%, P1 3.0%, P3 2.8% |
| core-14 | Qwen3-0.6B-Q4_0 | lemonade ROCm | 256.56 | 238.34–259.97 | 8 | 9% pooled spread — wider than its own stated noise floor |
| core-17 | Qwen3-0.6B-Q4_0 | lemonade ROCm | **~265** | 263.6–271.4 | 12 | Half the samples are 0.21–0.28 s generations; do not quote 4 s.f. |
| beta-max | Qwen3-0.6B-Q4_0 | lemonade ROCm | 266.2 | 248.1–269.7 | 16 | Warm-up 238.8 discarded |
| fzzy | Qwen3-1.7B | llama.cpp ROCm | ~84 | — | — | Baseline; no sweep point beats it |
| razer | Qwen3-4B-Instruct-2507 | vLLM 0.28.0 CUDA | 49.18 | 48.71–49.39 | 16 | **Quote the median, not the min** — 48.71 is a cold-start artifact (first request after ~2 h idle, no warm-up excluded on that arm) |
| razer | Qwen3-0.6B (drafter standalone) | vLLM CUDA | 270.7 | — | — | Measured under different flags on an empty GPU — not a matched comparison |
| core-4 | gemma3:1b Q4_K_M | ollama 0.16.1, **`num_gpu=0` forced** | — | P1 88.31 (75.36–100.89) · P2 104.12 (100.75–104.74) · P3 96.19 (83.25–100.96) · P4 102.55 (94.24–104.95) | 20 | **Never quote as core-4's serving performance** — the default GPU path returns HTTP 500 on 100% of requests |
| liam-mbp | gemma4:e4b | ollama 0.33.3 Metal | 30.0 | 25.5–33.5 | 12 | **Contaminated** — 6 of 12 samples returned `chars=0` (hidden reasoning), and the reported max is one of them |
| liam-mbp | LFM2.5-1.2B | mlx-dspark (serving path) | — | P1 57.4–64.4 · P2 72.1–77.1 · P3 44.5–48.5 · P4 43.5–44.9 | — | Four disjoint bands; a pooled "43.5–77.1" describes nothing. Node was contended throughout — all figures are lower bounds |

### 5.3 Embeddings

| Node | Model | Latency | Notes |
|---|---|---|---|
| core-1 | nomic-embed-text | 18.1–21.6 ms (19.3% same-prompt spread), ~48 emb/s | Corrected from the reported 19.9–21.6 ms / 8% |
| core-4 | nomic-embed-text | **Bimodal**: 17/20 at 19.3–28.5 ms, 3 at 100–115 ms | Per-prompt noise floor up to 5.40x — unusable for any A/B |

---

## 6. Refuted and unsupported claims

This section is the point of the adversarial pass. Every item below was written down as a finding by a benchmarking agent and knocked down by a verifier. **Nothing here should enter the fleet record.**

### 6.1 REFUTED — contradicted by the node's own data

| Node | Claim | Why it fell |
|---|---|---|
| beta-red | "The 0.567x is a clean speculative-decoding effect; the mechanism is the extra forward pass" | The spec arm ran **25/66** layers, the baseline **29/66** — 862 MiB more on the CPU, perfectly arm-correlated across all 7 launches. The report quotes only the 29/66 figures and never mentions 25/66 anywhere |
| beta-red | `ttft_ms` values are measured raw data | Every spec-arm TTFT is **byte-identical** to its baseline counterpart — impossible across separate processes with different offload splits. Reps 2–3 carry round-number back-fills; one is contradicted by the log by 3.0 s. **Part of a "raw" column was not measured** |
| beta-red | "No other client ever hit the backend" | `100.72.243.39` polled `/api/tags` five times before the session. No contention occurred, but the claim is false, and a 6-line excerpt was labelled the "full session GIN log" when the session produced 59 lines |
| beta-red | "`who` and `last` returned empty" | `last` is not installed on that host; `who` returns empty even with an active SSH session |
| beta-red | "Model load is 156 s; arm switches cost 120–156 s" | 156.49 s occurred once, cold-cache. Subsequent reloads: 109.6, 112.6, 95.5, 105.8, 97.5 s |
| core-1 | "Position-1 acceptance is exactly 1.000 at depths 1, 2, 4 and 6" | Those values exist **only in each depth's warm-up task** — the runs the report says it discarded — and contradict its own depth table (0.910 / 0.938 / 0.919 / 0.881) |
| core-1 | "Positions 7 and 8 (21.8%, 17.8%) bracket the reported 12.8%" | Arithmetically false — both exceed 0.128. The lowest per-position acceptance measured anywhere on that node is **17.8%** |
| core-1 | "ROCm and Vulkan acceptance are byte-identical, so acceptance is backend-independent" | The two ROCm blocks give P1 = 0.693 against Vulkan's 0.788 — a **9.5-point divergence the report omits entirely**. Only the code prompt matches. The ROCm path also saw just 25.8 GiB and logged `device ROCm0 does not have support for op TOP_K` |
| core-1 | qwen3.6:27b headline `min 13.014 / median 29.004` | Internally incoherent: the samples array contains 12.064 (below the stated min), and 29.004 is the spec-on-only median, not the median (~25.78) of the reported set |
| core-1 | "`OLLAMA_NUM_PARALLEL=1`, as fleet policy requires" | That variable **is not set anywhere on the node** — absent from both drop-ins, from `systemctl show`, and from `/proc/<pid>/environ`. The quoted evidence line corresponds to no real command output. (Effective parallelism *is* 1, via the runner's `-np 1`) |
| core-1 | "Embedding band 19.9–21.6 ms, an 8% band" | The report's own raw data contains 18.1 ms, and it is load-bearing (13 tok / 18.1 ms = the reported 720.2 tok/s). Real band 18.1–21.6 ms = **19.3%** |
| ci | "P2 (code) is consistently the slowest prompt" | The report's own printed per-prompt medians make **P4** slowest (39.090 vs 39.110), it flips between rounds, and the 0.05% gap is an order of magnitude inside the 0.40% noise floor |
| ci | "Layer-offload count changed 35/35 → 37/37, so throughput is sensitive to iGPU memory pressure" | A misread. Blob `sha256-aeda25e63ebd` (35/35) is **gemma3:4b**, which has 35 layers; `sha256-a3de86cd1c13` (37/37) is **qwen3:8b**, which has 37. Both are complete offloads of different models. The whole memory-pressure conclusion has no evidence behind it |
| ci | "qwen3:8b ran at KvSize 65536" | Runtime KvSize was **40960** at every load (clamped to the model max). 65536 applied only to gemma3:4b |
| ci | "Reproducibility across ~15 min" | Actual span 5m39s |
| ci | "Measurements taken against `http://100.87.68.116:11434`" | Every `/api/generate` in the journal originates from `127.0.0.1` — the harness ran on the box over loopback |
| core-7 | "Backend loopback curl returns empty with **exit 0** — a silent failure that looks like a dead backend" | `curl` to loopback exits **7** with http_code 000 — a loud, correct failure. A health check would correctly report down. This is the pipe-masks-exit-status mistake, and the fleet-facing warning derived from it is **inverted** |
| core-7 | "Every block began with a discarded warm-up generation" | Only `start-swa.sh` contains a warm-up. `start-baseline.sh`, `start-budget.sh` and `restore-lucebox.sh` contain none, and `start-baseline.sh` does not even poll `/health` |
| core-7 | "Conclusions unchanged if the cold first block is dropped" | The ratios are right but the **noise floor** collapses from ~6% to ~2%, which flips the P1/P3 verdicts. The report recomputed the ratios and not the floor |
| core-7 | "The 12.8% figure is reproducible on this node" | No prompt produced 12.8%. Measured: 16.0, 18.8, 22.5, 56.6% |
| core-7 | Spec decoding is a like-for-like speedup on the same work | Output diverges between arms at temperature 0 on P1, P3 and P4 |
| core-14 | "Noise floor is 0.94%; any effect above ~3% is real" | That floor is within-block jitter. Block-to-block drift in the report's own raw data is **2.6–4.5%**, both arms, same direction. P3's 4.3% sits inside it |
| core-14 | "`DFLASH27B_DRAFT_SWA` is inert" | `accept.sh` greps container logs for `swa` and **no SWA line appears for any case**, while the production container demonstrably prints `[draft] SWA layers: 4/5 (window=2048)`. Bit-identical acceptance *and* output hash is the signature of a no-op control. "Inert" cannot be distinguished from "never applied" |
| core-14 | "Each block preceded by a discarded warm-up" | `spec_r1.jsonl` has no `WARMUP-DISCARD` record and is the lowest block across all four prompts |
| core-14 | "ci-os-hub burns a full CPU core continuously" | Live `docker stats`: 0.00%. Load average is still ~0.98 without it, so the attribution is wrong |
| core-17 | "The 2.522x on P2 is ~40x the noise floor" | No definition yields 40x — it is ~10x (inter-arm gap / intra-arm spread), ~24x (against spec noise) or ~72x (against baseline noise) |
| core-17 · beta-1 · beta-max · core-7 | Top-level `median_tok_s` / `min` / `max` / `uplift` / `acceptance_rate` | Every one pools an overtly bimodal four-prompt distribution. beta-1's min/max additionally cover only 12 of 34 samples in the array beside them, and its `uplift` (1.83) cannot be derived from its own `baseline_median`/`spec_median` (which give 1.55) |
| beta-ms-a2 | "Headline uplift 1.75x" | That is the **pooled** median ratio. The median of per-prompt paired ratios is **1.71**. Pooling happened to favour the larger number |
| beta-ms-a2 | "Foreign pollers stopped at 15:40" | `100.72.243.39` hit `/api/tags` at 21:19:40 — and that address is the agent's **own orchestration host** |
| beta-max | "The box was genuinely quiet" | `hub-tailscale` is in a permanent crash loop, `RestartCount=11463`, respawning every ~60 s throughout the entire measurement window |
| beta-max | Evidence line `[target] target loaded: ... 850 tensors on GPU 14.99 GiB, tok_embd 682 MiB CPU-only` | Does not exist anywhere in the as-deployed container's 412-line log |
| beta-max | The 8216 lucebox stack is "as-deployed production, left completely untouched" | Model files written 03:23 UTC, container created 03:26:27 UTC with `RestartCount=0` — **83 minutes before the first measurement**, while every other container has 8 days uptime. It is a fresh provision |
| beta-max | "12.8% sits squarely inside this box's prose band" | 12.8% is **below** the measured prose band of 16.0–18.8% |
| liam-mbp | MTPLX "confirms the known ~1.0x" | Reached only by pooling 12 ratios across four prompts. Per prompt, 3 of 4 do not straddle 1.0 |
| liam-mbp | "Non-identical output" — omitted entirely | All 12 P1 and P4 race records carry `"identical": false` in the file the report retained, with differing token counts on P4. Never mentioned |
| everxr-01 | Bandwidth "independent corroboration" (1441 vs 915 GB/s, "1.57x above the ceiling") | An 8B model's *achieved* bandwidth is not the GPU's ceiling. Under the report's own "32 GB card" alternative the two figures become 51% and 80% utilisation — both ordinary — and the corroboration evaporates |
| everxr-01 | "Warm-up discarded" | The first retained 8B sample carries `ttft=3781 ms`, meaning a model load immediately preceded it. Both post-load 27B samples are the minimum of their prompt group |
| beta-nas | "Every one of these sits far outside the noise floor, so all four are real" | Fails for P1. The floor is max/min over n=2 of a computation the report itself calls bit-deterministic — it bounds host timing jitter, not effect variance |
| beta-nas | llama-server `min 4.117 / max 4.168` | Describes only the spec-OFF arm while sitting beside a samples array containing 3.886 and 6.517 |
| razer | Backend-level `median 49.18 / min 48.71 / max 49.39` | Describes only 16 of the 64 samples in the array beneath them, which span a 270.98 tok/s drafter and a 91.51 tok/s spec sample |

### 6.2 UNSUPPORTED — plausible but not established, or evidence destroyed

| Node | Claim | Status |
|---|---|---|
| **All lucebox nodes** | Any cross-node uplift ranking ("gfx1151 exceeds gfx1100's 1.75x", "gfx1151 beats the 72% figure", "2.40x is better than beta-1's 1.75x") | **Unadjudicable.** Compares one node's best single prompt against an external figure of unknown prompt mix, denominator and aggregation. Four separate verifiers flagged this same error on four separate nodes |
| beta-1 | "The known 1.75x is CONFIRMED — I measure 1.83x on the same aggregation basis" | The recorded figure's aggregation basis is **unstated and unknowable**. The same 24 samples yield 1.55x, 1.83x, 1.88x, 2.05x or 3.65x depending on aggregation. A scalar inside that envelope is *compatible with*, not confirmed by, the measurement — and on the two most conventional aggregations this node measures **1.55x**, which reads as a ~12% shortfall |
| beta-1 | "72% acceptance CONFIRMED" | Confirmation by selection: the report's own headline is 77.6%, and it quotes P1 (71.6%) and P3 (71.9%) while setting aside P2 (88.8%) and P4 (75.0%). Denominator mismatch on top of that |
| core-1 | "HARD CONTRADICTION of the gfx1151 acceptance-collapse hypothesis" | No gfx1100 comparison was run; lemonade is not installed on that node; the separate-draft-model pairing that produced 12.8% was never exercised there. The narrow claim survives: *gfx1151 silicon is not intrinsically incapable of high draft acceptance* |
| core-1 | "Depth 4 beats default depth 3 by 16.5% — ollama's default leaves ~17% on the table" | n=1 per (depth, prompt), two prompts, no reps, tok/s not in the journal. Depth 6 ties depth 4 on code yet regresses 17% on prose — not the behaviour of a well-sampled optimum. **Do not change caller code on this** |
| core-7 · core-14 · beta-max | "`--ddtree-budget` is inert" | core-7 retained **no raw data at all** for the budget experiment. core-14's sweep *is* verified (six budgets, each confirmed at startup, bit-identical acceptance and output hash) — but because acceptance is a deterministic function of the prompt on this engine, identical acceptance cannot distinguish an inert flag from an unapplied one. beta-max's budget-8 container and log were destroyed |
| core-14 | "budget=32 makes P1 13% slower" | n=1 against a five-launch cluster; no matching effect on P2 at the same budget |
| core-17 | The `ddtree`-off control container returned byte-identical acceptance | Container removed and logs unrecoverable. Mechanistically plausible (`proposals = steps × 16` holds in all 22 surviving lines) but unverified |
| core-17 | X3 "numbers 1-to-100" independently measured 56.6% | Its log line is **byte-identical in every field** to P2's, so it cannot be distinguished from a P2 re-run |
| beta-ms-a2 | Interleaving of the spec A/B | The whole A/B ran inside one detached script; script and output log deleted at cleanup. Nothing on the node records arm ordering. **Mitigating:** the run occupied a single 20-minute window on a box with confirmed zero foreign traffic, so the hours-apart confound is structurally excluded regardless |
| beta-ms-a2 | "Two independent paths to the same 1.75x" (convergence with lucebox) | Numerological, and partly an artifact of the pooling error — the paired figure is 1.71 |
| beta-nas | "1.57x on code — the win generalizes to code generation" | One Python linked-list-reversal prompt measured twice per arm. One prompt is not a category |
| beta-nas | The P3 prose slowdown is caused by wasted verification work | The agent **measured the controlling comparison** (grepped offload/buffer lines from both arms' logs) and did not report it. On a 100%-full 8 GiB card the draft context can shift the layer split by exactly the few percent seen |
| beta-nas | "ollama simply never passes the flag; the fix is running llama-server manually" | Incomplete. The same binary exports `resolveExperimentalDraftDir`, `CreateDraftLayers`, `convertMTPDraftFromSafetensors` and carries `draft/config.json`, `draft_num_predict`, `OLLAMA_EXPERIMENT` — ollama has a designed experimental path for attaching a draft to a model. Investigate that before recommending a second llama-server on every node |
| everxr-01 | "Speculative decoding is already ON via the MTP head" | A one-model-pair correlation whose sole control differs on **four axes at once** (architecture family, SSM-hybrid vs pure attention, 8.8B vs 27.3B, nextn present vs absent). **Demote to leading hypothesis.** A same-architecture control was sitting unused on the box — see §8 |
| everxr-01 | "Monotonic predictability ordering, 1.63x span" | Pools four prompts from **two different experiments** with different n, and its slowest point (P1) is the only truncated generation (eval_count 87 vs 160) |
| everxr-01 | `think:false` silently ignored by qwen3-vl:8b | No raw response body, no thinking-field dump, no resp_chars in the evidence. Plausible operational warning, unverified |
| core-4 | "P2 is the fastest prompt" | P2 [100.75–104.74] and P4 [94.24–104.95] overlap heavily and P4's max **exceeds** P2's. "Most stable" holds; "fastest" does not |
| core-4 | "The box was idle" | HTTP-side check only — no uptime, load, or `docker stats` (SSH refused). Rules out competing *inference*, not general CPU contention, which is precisely the confounder for CPU-bound numbers. Supportable claim: *no competing inference engine was reachable on the scanned ports* |
| core-4 | "Noise floor ~1.34x" | max/min over n=5 systematically understates spread — treat as a **lower bound**. P1's width is additionally a short-sample artifact (only prompt that stopped at 80 tokens) |
| fzzy | "P1 shows a real 0.96x slowdown, far outside the noise floor" | 1/0.958 = 1.044, and P1's own baseline arm spread is 1.044. **Inside** the noise floor |
| fzzy | "acceptance_rate = 0.566 for this node" | Cherry-picked — the code prompt alone. The same run recorded 0.160, 0.188 and 0.225 |
| fzzy | "The acceptance sweep is deterministic and reproduced exactly across reps" | An earlier sweep (`sweep.log`) was broken by a malformed `pkill` (flat tok/s at 67.9–68.9 across all n_max) and discarded without disclosure. Only **one** acceptance point is actually reproduced between the two runs. The published sweep's tok/s column is one sample per point, and its "n_max=3 is optimal" peak is an unreplicated outlier |
| fzzy | "ollama's AR decode is ~8% faster than lucebox's" | Non-interleaved blocks 10 min apart, different engines, different KV/quant config, and lucebox's baseline shared GTT with a resident second 27B container |
| liam-mbp | "32 of 32 paired ratios below 1.0" | Only **24** are retained and verifiable. The 8 Round-3 ratios exist in no file on disk |
| liam-mbp | Round 3 is the "DECISIVE" round | No raw data retained; its control band is **28x wider** than round 1's on the same server and arms; its central inference (a 1.103 first-arm advantage) is contradicted by the retained data, where the order effect is 1.016–1.026 |
| liam-mbp | "Directly contradicts the known 1.22–1.49x mlx-dspark uplift" | The finding lives entirely on `/admin/race`, which by its own source (`server.py:1263–1266`) **builds a fresh cache per arm and bypasses the prefix cache**, and is described in that source as "artificially slow". dspark vs baseline was never A/B'd on the serving path |
| liam-mbp | MTPLX compute library is Metal | Inferred, not read. No MTPLX log exists anywhere; its endpoints expose no device. Rule 7 genuinely unsatisfied |
| razer | "3 beats 5 for `num_speculative_tokens`" | The k=5 arm ran **once, last, un-bracketed**. Two of four "drops" are inside that arm's own restart-to-restart noise (−2.8% vs 2.66%, −3.0% vs 3.81%). The acceptance drop (33.9% vs 42.8%) does support the direction with large N — claim that, not the throughput |
| razer | Losslessness verified by SHA-256 | No artifacts survive; the harness was deleted at restore. The *reasoning* is sound (P4 diverged between two runs of the **same** arm), and the operationally useful half stands: output-hash equality cannot be used as a correctness gate here |
| razer | "Third datapoint on the gfx1151 question — 42.8% brackets 72% and 12.8%" | Three simultaneous confounds (vendor, engine, model pair) and n=1 per point. A number landing between two others from unrelated populations is not evidence about either |
| beta-red | The script-substitution anomaly, and the P3/P4 cross-arm text divergence | No forensic trace survives. Given the 29-vs-25 layer confound, any divergence is as plausibly the differing CUDA/CPU boundary as batched draft verification |

### 6.3 Systemic methodology failures worth institutionalising

Ranked by how often they appeared:

1. **Pooling across prompts into the structured summary fields** — 9 of 15 nodes. The prose almost always disowns the number; the JSON field almost always keeps it. Downstream aggregators read the field. **Fix: forbid scalar `uplift` / `median_tok_s` / `acceptance_rate` in the schema; require a per-prompt array.**
2. **Noise floor measured in the wrong dimension** — 5 nodes. Within-block or within-load repetition was used to certify a *between-block* or *cross-load* effect. On core-14 the correct floor is 3–5x wider than the quoted one; on core-7 it is 3x. **Fix: the floor must be measured across the same boundary the arms cross.**
3. **Raw evidence destroyed at cleanup** — 6 nodes (beta-nas, beta-ms-a2, core-7, core-17, beta-max, liam-mbp). In every case the destroyed half is the *control* arm, so the surviving data can never falsify the finding. **Fix: ship the bench script and its raw output back with the report, or persist them under a retention path, before any teardown.**
4. **Warm-up asserted rather than performed** — 5 nodes. beta-max's warm-up generated 3 tokens; core-7's and core-14's covered only some blocks; razer's as-deployed arm had none; everxr-01's first retained sample was immediately post-load.
5. **Arm order not counterbalanced** — core-14 (spec always first, with monotonic upward drift, inflating the P1 slowdown and deflating P3/P4).
6. **A control was measured and then not reported** — beta-nas (offload parity between arms), beta-red (25/66 vs 29/66). Both would have overturned the headline.
7. **Precision far beyond the sample size** — near-universal. n=2 to n=4 per cell with ratios to four significant figures.

---

## 7. Cross-cutting operational findings

These are not spec-decode results but every one is a real fault or trap that a verifier reproduced live.

**Product defects:**
- **CI-Hub's ollama health probe is false-green and Hub Pool routing depends on it.** `ollama.backend.ts:84` only GETs `/api/tags` and calls any 200 healthy. On core-4, `/api/inference/health` reports `running:true healthy:true` while default generate requests return HTTP 500. `hub-pool-proxy.service.ts:357-358` selects local candidates on `health.running && health.healthy && health.modelsLoaded.includes(model)` and line 375 selects peers on the same signal, with `modelsLoaded` populated from `/api/tags` names. **Hub Pool would actively select core-4 to serve `gemma3:1b` and then fail every request.** A load-bearing probe should attempt a 1-token generation.
- **core-4's ollama GPU offload is broken** — default options HTTP 500 `model failed to load` in 3.39 s; `num_gpu=0` HTTP 200 in 0.83 s. Independently reproduced a day later. The node serves nothing to a standard client.
- **lucebox `usage.accept_rate` is a raw token count, not a rate** (beta-1: `accepted=142/1 (14200.0%)`). Anyone consuming it as a percentage corrupts fleet numbers.
- **`qwen3.8:27b` is broken on the normal API on beta-ms-a2** — `/api/chat` and `/api/generate` both return HTTP 500 `unknown renderer "qwen3.8"`. Only `raw:true` works. Any fleet routing sending chat traffic there gets a hard error.
- **lemonade's `Qwen3-1.7B-spec2` is inert** (§1.4).

**Fleet-tooling traps, all reproduced live:**
- `gpu_busy_percent` / `rocm-smi --showuse` reads a **constant 100** on idle Strix Halo — confirmed on core-1, core-7, core-14, core-17, beta-max, fzzy. **Never gate a quiet-check on it.** Use socket power (33–40 W idle vs 74–77 W generating).
- `rocm-smi` "VRAM Total" reports **512 MiB** on gfx1151 — that is only the carve-out; the real pool is ~61–63 GiB of GTT. lemonade separately under-reports it as `vram_gb 2.0`.
- `free -g` on core-1 shows **30 GiB** against 111.3 GiB GPU-visible.
- **`OLLAMA_VULKAN=1` alone does not select Vulkan** (ci: every unforced load picks ROCm). Forcing it needs `OLLAMA_LLM_LIBRARY=vulkan` — and on fzzy, `OLLAMA_LLM_LIBRARY=vulkan` **without** `OLLAMA_IGPU_ENABLE=1` silently falls back to **CPU** (`dropping integrated GPU` → `inference compute id=cpu library=cpu`). This is the exact rule-7 trap.
- **Tailnet-only binds break loopback health checks** on beta-nas, beta-red, core-7, core-17, fzzy, razer (ollama/lucebox/lemonade bind the tailnet IP, nothing on `127.0.0.1`). Note core-7's inverted warning in §6.1 — `curl` exits 7, loudly, so a health check *does* correctly report down.
- **`last` is not installed on several hosts, and `who` returns empty even with an active SSH session** — on core-1 `uptime` reports 6 users while `who` returns nothing (stale utmp). Neither is a quiet-check signal. The load-bearing evidence is single-client-IP request logs, load average, and idle GPU.
- **everxr-01 has no SSH** (port 22 and WinRM 5985 closed; Tailscale SSH is Linux/macOS only). It belongs permanently in the HTTP-only measurement bucket, and the runbook's `ssh root@<ip>` line cannot work there under any username.
- **ollama silently discards unknown request options** (everxr-01, 0.33.3): all 11 toggle syntaxes returned within the noise floor with `load_ms` 2–3 ms and no runner rebuild. **A null result from passing an option is evidence the option was thrown away, not that it was honoured.** Always run a bogus-option negative control, as beta-red did.
- **CI-Hub's SPA catch-all returns HTTP 200 for any non-`/api` path under GET.** core-4's and beta-max's 404 probe tables only reproduce under POST. Always state the method.
- **NFS-backed `OLLAMA_MODELS`** costs 62–97 s cold loads vs 10.6 s from page cache (beta-ms-a2), and is the same share implicated in core-1's historical restart loop.
- **Undocumented engines:** core-14 runs a fourth inference engine (host-process ollama on :11434, invisible to `docker ps`) holding `nemotron-cascade` and `nomic-embed-text-v2-moe`. beta-1 runs two ollama instances. Neither is in the fleet inventory.

**Hardware-record corrections:**
- **beta-1 has TWO RX 7900 XTX cards**, not one — `rocm-smi` GPU[0]/GPU[1], `lspci` at 43:00.0 and 83:00.0. lucebox is pinned to a single render node (`renderD129`) that it **shares with the GNOME desktop compositor**, while the second 24 GB card sits idle at 0%. A pre-existing VRAM OOM at 02:47Z (auto-restarted, outside the measurement window) is plausibly explained by that sharing.
- **beta-red is an RTX 3080 10 GB** (10240 MiB), not an unqualified "RTX 3080".
- **razer is an RTX 4080 *Laptop* GPU, 12282 MiB**, not a 16 GB desktop 4080. Anyone planning capacity at 16 GB will be wrong.
- **beta-nas has a second, entirely unused AMD Strix 880M/890M iGPU** at PCI c8:00.0 (`OLLAMA_IGPU_ENABLE` unset).
- **beta-ms-a2 is CPU-only** — a gfx1036 display iGPU with 2 compute units, no discrete GPU. `OLLAMA_VULKAN=1` and `OLLAMA_IGPU_ENABLE=1` are set and inert. **Do not "fix" this into Vulkan.**
- **ci and core-1 should record gfx1151/Strix Halo explicitly** — the inventory strings "AMD, host ROCm 10" and "Strix Halo" are accurate but incomplete, and this is the silicon in the open acceptance question.
- **everxr-01's GPU part, peak bandwidth and compute library are all UNKNOWN.** VRAM is ≥17.75 GB and <~27.6 GB usable from coresidency/eviction evidence. Do not let "consistent with a 4090 or better" harden into a spec.
- **core-4's hardware remains unknown and should stay recorded as unknown.** `hardwareTier: "high"` is **not** evidence of a GPU — `computeTier` at `hardware-inspector.service.ts:351` reaches "high" through a second branch requiring only an inferred unified-memory GPU plus ≥32 GB RAM, with `runtimeAvailable` false.

**Capacity-planning corrections:**
- **beta-nas is not a GPU-serving node for 27B.** 17.42 GB Q4_K_M on an 8 GiB card, 20/66 layers resident. Two-thirds of every token's weight traffic comes from system RAM. 4.56 tok/s is a **CPU-bound** number.
- **beta-red is likewise CPU-bound** at 29/66 layers, and its context is **silently capped to 4096** despite the model advertising 262144. Long-context requests are truncated without warning. Reassigning a model that fits in ~9 GB is the single highest-value change for that node.
- **ci's root filesystem is 98% full with 22 GiB free** (worse than the 97%/28 GiB in the drop-in comment). `/models` is a separate NVMe at 35%. Unused CUDA backend dirs total ~3.4 GB.

---

## 8. Open questions and the next experiment for each

| # | Open question | The specific next experiment |
|---|---|---|
| 1 | **Is the gfx1151/gfx1100 acceptance difference real at all?** All current evidence says no, but no single run controlled both sides. | Run the **identical four-prompt mix** on beta-1 (gfx1100) and one gfx1151 node **under the same lucebox image tag** (upgrade beta-1 to `:rocm-7.2` or downgrade a gfx1151 node to `:rocm`), and record `avg_commit`, `steps`, `accepted`, `proposals` and `tokens` per request. Publish avg_commit, not a percentage. **Highest-value experiment in this list.** |
| 2 | **What is the true accepted/proposed rate on gfx1100?** Its build never logs proposals. | Patch or instrument the `:rocm` build to log proposal counts, or run beta-1 under `:rocm-7.2` where `proposals = steps × 16` is emitted. Until then no gfx1100 acceptance figure is comparable to anything. |
| 3 | **Does "target fits in VRAM" gate MTP uplift on ollama?** Perfectly collinear with the layer-split confound on both partial-fit nodes. | On beta-red, re-run the A/B with **`num_gpu` pinned to the same value in both arms** (25, the lower of the two) so the layer split is identical, then repeat with a model that fits entirely in 10 GB. Same on beta-nas. Report the offload line from both arms. |
| 4 | **Is everxr-01's content-dependent 1.41x actually the MTP head?** Its sole control differs on four axes. | Run the identical four-prompt mix against **`minicpm-v4.6`**, already resident on that box: `general.architecture=qwen35` **with** `qwen35.ssm.*` and `full_attention_interval=4` but **without** `nextn_predict_layers`. Flat → MTP implicated. Content-dependent → the effect belongs to the qwen35 decode path and the MTP story is wrong. Capture `prompt_eval_count` and `eval_count` per sample. One short run settles it. |
| 5 | **Is "Vulkan is ~30% faster than ROCm on core-1" still true?** ci measures ROCm 3–4% faster; fzzy measures ROCm winning wall-clock. core-1 ran Vulkan-only this pass. | Run a **paired, interleaved Vulkan/ROCm A/B on core-1** with the same model and length-matched prompts, exactly as ci did (V/R/V/R across service restarts, engine library read from the journal at every switch). Until then the 30% figure supports no decision. |
| 6 | **Why is lucebox's autoregressive path nondeterministic against itself at temperature 0?** (fzzy: P1 baseline gave 81 tokens on rep 1, 73 on reps 2–3.) And why do spec and AR arms diverge on 3 of 4 prompts? | Fix a seed, run 10 identical AR requests at temperature 0 on one gfx1151 node, and hash the outputs. If they diverge, this is an engine correctness bug that invalidates *every* output-comparison methodology on this fleet, spec-decode or not. **Escalate to lucebox.** |
| 7 | **Do the `--ddtree-budget` and `DFLASH27B_DRAFT_SWA` knobs reach the engine at all?** Bit-identical results are equally consistent with "inert" and "never applied". | Repeat each sweep while **reading the value back from the container startup banner** (core-14 did this for budget and not for SWA), and retain the raw output. Bit-identical *acceptance* proves nothing on this engine, since acceptance is a deterministic function of the prompt — you need the startup line. |
| 8 | **Does ollama's experimental draft path let a drafter be attached to an existing model?** The binary exports `resolveExperimentalDraftDir`, `CreateDraftLayers`, `convertMTPDraftFromSafetensors` and carries `draft/config.json`, `draft_num_predict`, `OLLAMA_EXPERIMENT`. | On one node, try `ollama create` with `--experimental` and a draft directory against a GGUF target, then check whether the resulting manifest carries a draft layer and whether the runner cmdline picks up `--spec-type`. This would replace the "run a second llama-server on every node" recommendation. |
| 9 | **What is mlx-dspark's real serving-path uplift on Apple silicon?** The only measurement lives on `/admin/race`, which bypasses the prefix cache by design. | A serving-path A/B — which requires a restart, and therefore requires liam-mbp to be free. **Do not schedule this while the operator is working.** Until it runs, the contradiction against the recorded 1.22–1.49x must be filed as *not comparable as measured*, not as a contradiction. |
| 10 | **Is core-1's depth-4 tuning win real?** n=1 per point, two prompts, tok/s not in the journal. | Re-run the depth sweep with **3 reps per (depth, prompt)** on all four prompts, capturing tok/s. Do not change any caller's `draft_num_predict` until this lands. The one sweep point corroborated by a second instrument is the **depth-8 net slowdown** (12.06 vs 13.02 tok/s, backed independently by acceptance collapsing to 43.6% at d8). |
| 11 | **Does any gfx1151 node's per-step overhead respond to tuning?** core-7's model puts fixed overhead at ~293 ms = 3.43 target forwards, break-even ~3.7 committed tokens/step — and gfx1151 prose sits at 3.52–4.00. This is *the* gfx1151 bottleneck. | Profile a single speculative step on gfx1151 to attribute the 293 ms. If it is drafter forward-pass latency, a smaller drafter should move it; if it is tree-verification or host-side scheduling, it will not. Re-fit the cost model with more than one leverage point — the current slope rests almost entirely on P2 (drop P2 and it swings from 6.04 to 11.17 ms/token). |
| 12 | **What is everxr-01's GPU?** No shell, closed 22/5985. | Establish a Windows remote-exec path (WinRM enable, or an agent), then read the compute library from ollama's own log. Until then all everxr-01 hardware statements stay "unknown". |
| 13 | **How widespread is the lucebox `/1` accept_rate bug?** Demonstrated on one image on one node. | Grep every lucebox node's container log for `/1 (` and record the image tag. Then re-derive acceptance fleet-wide on **one agreed definition** before any cross-node acceptance number is published again. |

---

*Compiled from 15 node reports and 15 independent adversarial verifications. Where a verifier and an original report disagree, this document follows the verifier. Where a verifier could not check a claim, the claim is marked unverified rather than dropped silently — an unverifiable claim is itself a methodology finding.*
