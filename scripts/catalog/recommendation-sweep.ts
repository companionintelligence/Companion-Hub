/**
 * Shows which recommendations a catalog edit moves: sweeps memory sizes and compares each backend's picks
 * with the named rows present against the same catalog with them removed.
 *
 * WHY: the recommender ranks on the Artificial Analysis Intelligence Index first, and an unscored row counts
 * as 0 (`compareLlmCandidates`). Every oMLX and vLLM row is unscored, so among them the largest parameter count
 * that fits wins, and index 0 is what app bootstrap installs. Adding a row can therefore change the default
 * on some memory size without anyone choosing to: on 2026-11-15 `laguna-xs-2-1-mlx` (33B) would have replaced
 * DeepSeek R1 32B as the default on a 32 GB Mac. A new row's own tests cannot see that.
 *
 * Usage (offline; run from packages/backend so tsx reads its tsconfig paths):
 *   cd packages/backend && pnpm exec tsx ../../scripts/catalog/recommendation-sweep.ts <id,id,...>
 * Prints one `DEFAULT CHANGED` line per backend and memory size whose index-0 pick differs, then one summary
 * line: the profiles swept, the default changes, and the other top-5 lists that changed below index 0 (new rows
 * appearing among the options is the point of adding them). Memory sizes between the real ones (a 40 GB Mac, a
 * 70 GB card) are swept too, so read a change there as a hint about ranking, since nobody owns that configuration.
 */
import { CURATED_MODELS } from '../../packages/backend/src/modules/inference/catalog/curated-models';
import { ModelRegistryService } from '../../packages/backend/src/modules/inference/model-registry.service';

// Taken from the method this script drives, because knip rejects an `@ci-hub/common` import at the repo root.
type HardwareTier = Parameters<ModelRegistryService['getRecommendedModelsForHardware']>[0];
type HardwareProfile = Parameters<ModelRegistryService['getRecommendedModelsForHardware']>[1];
type HostPlatform = HardwareProfile['os']['platform'];

const GB = 1024;
const newIds = new Set((process.argv[2] ?? '').split(',').filter(Boolean));
if (newIds.size === 0) throw new Error('usage: recommendation-sweep.ts <id,id,...> (the ids of the rows just added)');
const unknown = [...newIds].filter((id) => !CURATED_MODELS.some((m) => m.id === id));
if (unknown.length) throw new Error(`no catalog row has the id: ${unknown.join(', ')}`);

type Profile = { label: string; tier: HardwareTier; hardware: HardwareProfile };

/**
 * A machine's hardware profile. Its tier is a simplified copy of `HardwareInspectorService.computeTier` (the 16, 8
 * and 4 GB rungs on unified memory or VRAM, and cpu-only from 16 GB of RAM). Calling the real method would need
 * `@ci-hub/common` built, which a fresh checkout does not have, so keep the two in step.
 */
function profile(
  label: string,
  o: { vendor: HardwareProfile['gpu']['vendor']; vramGb: number; ramGb: number; unified?: boolean; arm?: boolean; platform: HostPlatform },
): Profile {
  const effectiveMb = (o.unified ? o.ramGb : o.vramGb) * GB;
  let tier: HardwareTier = 'insufficient';
  if (effectiveMb >= 16 * GB) tier = 'high';
  else if (effectiveMb >= 8 * GB) tier = 'medium';
  else if (effectiveMb >= 4 * GB) tier = 'low';
  else if (o.ramGb >= 16) tier = 'cpu-only';
  const hardware: HardwareProfile = {
    gpu: {
      available: o.vendor !== 'none',
      vendor: o.vendor,
      model: 'Test GPU',
      vramMb: o.vramGb * GB,
      unifiedMemory: o.unified ?? false,
      driverVersion: '550.0',
      runtimeAvailable: true,
    },
    npu: { available: false, model: '' },
    ram: { totalMb: o.ramGb * GB, availableMb: o.ramGb * GB },
    cpu: { arch: o.arm ? 'arm64' : 'x86_64', cores: 16, model: 'Test CPU' },
    effectiveInferenceMemoryMb: effectiveMb,
    tier,
    os: { platform: o.platform, name: o.platform, version: '' },
  };
  return { label, tier, hardware };
}

const profiles: Profile[] = [];
for (const ram of [8, 12, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 144, 160, 192, 224, 256, 384, 512]) {
  profiles.push(profile(`mac-${ram}GB`, { vendor: 'apple', vramGb: ram, ramGb: ram, unified: true, arm: true, platform: 'darwin' }));
}
for (let vram = 4; vram <= 192; vram += 2) {
  profiles.push(profile(`linux-nvidia-${vram}GB`, { vendor: 'nvidia', vramGb: vram, ramGb: 128, platform: 'linux' }));
  profiles.push(profile(`win-nvidia-${vram}GB`, { vendor: 'nvidia', vramGb: vram, ramGb: 64, platform: 'win32' }));
}
for (let vram = 8; vram <= 96; vram += 4) {
  profiles.push(profile(`linux-amd-${vram}GB`, { vendor: 'amd', vramGb: vram, ramGb: 64, platform: 'linux' }));
}
for (const ram of [16, 24, 32, 48, 64, 96, 128, 192]) {
  profiles.push(profile(`linux-amd-apu-${ram}GB`, { vendor: 'amd', vramGb: ram, ramGb: ram, unified: true, platform: 'linux' }));
}
for (const ram of [16, 32, 64, 128, 256]) {
  profiles.push(profile(`linux-cpu-${ram}GB`, { vendor: 'none', vramGb: 0, ramGb: ram, platform: 'linux' }));
}

/** A logger that says nothing: the registry only logs at boot, which this script never runs. */
const quiet = (): undefined => undefined;
const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, log: quiet, verbose: quiet } as never;

/** Each profile's recommended LLM ids per backend, best first. */
function picks(): Map<string, Record<string, string[]>> {
  const service = new ModelRegistryService(logger);
  const out = new Map<string, Record<string, string[]>>();
  for (const { label, tier, hardware } of profiles) {
    const byBackend: Record<string, string[]> = {};
    for (const m of service.getRecommendedModelsForHardware(tier, hardware)) {
      if (m.modality !== 'llm') continue;
      byBackend[m.backend] = [...(byBackend[m.backend] ?? []), m.id];
    }
    out.set(label, byBackend);
  }
  return out;
}

const withRows = picks();
// The registry reads this array, so taking the rows out of it gives the catalog as it was.
for (let i = CURATED_MODELS.length - 1; i >= 0; i--) {
  if (newIds.has(CURATED_MODELS[i]?.id ?? '')) CURATED_MODELS.splice(i, 1);
}
const withoutRows = picks();

let defaultChanges = 0;
let listChanges = 0;
for (const { label } of profiles) {
  const before = withoutRows.get(label) ?? {};
  const after = withRows.get(label) ?? {};
  for (const backend of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[backend] ?? [];
    const now = after[backend] ?? [];
    if (was.join() === now.join()) continue;
    if (was[0] === now[0]) {
      listChanges += 1;
      continue;
    }
    defaultChanges += 1;
    console.log(`DEFAULT CHANGED  ${label} ${backend}: ${was[0] ?? '(none)'} -> ${now[0] ?? '(none)'}`);
  }
}
console.log(`profiles swept: ${profiles.length}; default (index 0) changes: ${defaultChanges}; other top-5 list changes: ${listChanges}`);
