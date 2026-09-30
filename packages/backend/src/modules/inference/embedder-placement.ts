import type { HardwareProfile } from '@ci-hub/common/types';

/**
 * Whether an embedder should be loaded on the CPU rather than the GPU on this host.
 *
 * On AMD with ROCm, a second llama-server process on the card makes the GPU spin at 100 %
 * utilisation and max shader clock *while idle* — memory clock idle, no dispatches, ~100 W on a
 * 7900 XTX, ~45 W on a Strix Halo, and every other GPU user (the desktop compositor, the chat
 * model's next request) queued behind it. Measured 2026-09-30 on gfx1100: 27B alone idles at 1 % /
 * 13 W; 27B + nomic embedder idles at 100 % / 120 W; embedder moved to CPU, back to 1 % / 18 W. It
 * is AMD's MES firmware oversubscribing hardware queues across processes — ROCm/ROCm#5107 (and
 * #6390, lemonade-sdk/lemonade#2475, the same symptom). AMD has a MES fix for gfx12 (driver 31.20,
 * MES ≥ 0x8b); gfx11 — every 7000-series card and Strix Halo (gfx1151) — is "still under
 * development" as of 2026-06-25. The recommended workaround, `GPU_MAX_HW_QUEUES=1`, cannot reach
 * Lemonade's llama-servers: Lemonade spawns them with its own environment.
 *
 * So until that fix ships, an AMD ROCm host runs one llama-server on the card — the chat model —
 * and the embedder on the CPU. nomic-embed-text v1.5 is 137 M parameters: on a Ryzen 9 7900X a
 * 32-text pipeline batch takes 1.6 s and a search query 21 ms, which the embed queue (270 s batch
 * timeout) and search never notice; a Strix Halo's 16 Zen 5 cores should do about twice that.
 * Vulkan hosts are not affected, but nothing in the profile says which llama.cpp backend Lemonade
 * chose, and a CPU embedder costs a Vulkan host only a little speed — so the rule is by vendor.
 *
 * Lift this when a host's ROCm/MES firmware is known fixed; the profile carries no gfx target or
 * firmware version today, so that is a code change, not a probe.
 */
export function embedderRunsOnCpu(profile: Pick<HardwareProfile, 'gpu'>): boolean {
  const { gpu } = profile;
  return gpu.available && gpu.vendor === 'amd' && gpu.hostRocmAvailable !== false;
}
