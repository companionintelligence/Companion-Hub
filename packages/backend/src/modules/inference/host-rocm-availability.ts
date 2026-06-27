import fs from 'node:fs';
import { resolveContainerDataPath } from '@/common/helpers/container-paths';

export const ROCM_HOST_PROBE_PATH = '/data/state/hardware/rocm.json';

export type RocmHostProbe = {
  available: boolean;
  source?: string;
};

export async function readRocmHostProbe(): Promise<RocmHostProbe | null> {
  const probePath = resolveContainerDataPath(ROCM_HOST_PROBE_PATH);
  try {
    const raw = await fs.promises.readFile(probePath, 'utf8');
    const parsed = JSON.parse(raw) as { available?: boolean; source?: string };
    return {
      available: parsed.available === true,
      source: typeof parsed.source === 'string' ? parsed.source : undefined,
    };
  } catch {
    return null;
  }
}

async function runtimeRocmDevicesPresent(): Promise<boolean> {
  try {
    await Promise.all([fs.promises.access('/dev/kfd', fs.constants.F_OK), fs.promises.access('/dev/dri', fs.constants.F_OK)]);
    return true;
  } catch {
    return false;
  }
}

/** Host ROCm stack is present (Ollama / driver install progress). */
export async function isHostRocmStackAvailable(): Promise<boolean> {
  const probe = await readRocmHostProbe();
  if (probe?.available) {
    return true;
  }
  return runtimeRocmDevicesPresent();
}

/**
 * ROCm device nodes are available for Docker bind-mounts (/dev/kfd, /dev/dri).
 * Hub runs in Docker on Linux hosts, so the probe cache (written on the host) is
 * authoritative even when /dev/kfd is not visible inside the Hub container.
 */
export async function isRocmKfdPassthroughAvailable(): Promise<boolean> {
  const probe = await readRocmHostProbe();
  if (probe?.available && probe.source === 'host-dev-kfd') {
    return true;
  }
  return runtimeRocmDevicesPresent();
}
