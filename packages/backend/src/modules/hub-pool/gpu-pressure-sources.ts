import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PoolPressureSource } from './hub-pool.types';

/**
 * Where the host's `/sys` is expected inside the Hub container.
 *
 * Nothing in this repo mounts it yet, on purpose — see `docs/hub-pool.md`. A new unconditional
 * bind mount in `docker-compose.prod.yml` is the one change in this feature that could stop a Hub
 * booting, peerless ones included, so the reader ships first and the mount is an operator opt-in.
 * An absent directory is not an error here: it is the ordinary "unmeasured" answer, which ranks
 * neutral.
 */
export const HOST_SYSFS_ROOT = '/host/sys';

/**
 * Optional host-written pressure file, read through `FilesystemService` under the already-allowlisted
 * `DATA_DIR`, exactly like `hardware-inspector.service.ts`'s `rocm.json` / `nvidia.json` probes.
 *
 * **Nothing in this repo writes it.** It exists so that adding a vendor the Hub container cannot see
 * — NVIDIA above all, since `nvidia-smi` is not in the Alpine image and the Docker socket is `:ro`
 * for good reasons — is a writer change in the desktop app or a systemd timer on a fleet node,
 * rather than another source in here. Until such a writer lands, NVIDIA nodes report nothing and
 * rank neutral, which is the honest answer rather than a proxy that anti-correlates with load.
 */
export const HOST_PRESSURE_FILE_PATH = '/data/state/hardware/gpu_pressure.json';

/**
 * How old the host file may be before it is ignored.
 *
 * A stale file must read as *unmeasured*, never as idle: a writer that died with the card at 100%
 * would otherwise leave a permanent "this node is free" advertisement behind it.
 */
export const HOST_PRESSURE_FILE_MAX_AGE_MS = 60_000;

/** Only `cardN` directories. Skips `renderD128`, the `card0-DP-1` connector entries, `.` and `..`. */
const DRM_CARD_DIR = /^card\d+$/;

/**
 * The `schemaVersion` this build understands. A file claiming any other version is ignored outright
 * rather than best-effort parsed — a writer that changed the meaning of `busyPercent` must not have
 * an older reader quietly keep believing it.
 */
export const HOST_PRESSURE_FILE_SCHEMA_VERSION = 1;

export const hostPressureFileSchema = z.object({
  schemaVersion: z.number(),
  sampledAt: z.string(),
  /** Free-form writer id, for the operator's benefit. Never used to decide anything. */
  source: z.string().optional(),
  /** Device busy-ness, 0-100. The ONLY field read: see `occupancyFromHostPressureFile`. */
  busyPercent: z.number(),
});

export type HostPressureFile = z.infer<typeof hostPressureFileSchema>;

/** One source's answer: how committed the busiest device is, in [0,1], and which source said so. */
export interface PressureReading {
  occupancy: number;
  source: PoolPressureSource;
}

/**
 * The host file's contribution, or `null` for "this source has nothing to say".
 *
 * Only `busyPercent` is read, and this is the deliberate narrowing the design review forced: VRAM
 * residency reads the same whether an engine is generating or sitting idle with `keep_alive`
 * counting down, so a band built on it would have made the *coldest* node look busiest and the
 * warmest look free — the exact inversion `poolLocalAffinity` exists to price. Real device
 * busy-ness or nothing.
 */
export function occupancyFromHostPressureFile(file: HostPressureFile, now: number = Date.now()): number | null {
  if (file.schemaVersion !== HOST_PRESSURE_FILE_SCHEMA_VERSION) {
    return null;
  }
  const sampledAt = Date.parse(file.sampledAt);
  if (!Number.isFinite(sampledAt)) {
    return null;
  }
  // Symmetric: a writer whose clock runs a minute ahead of ours is exactly as untrustworthy as one
  // that stopped a minute ago, and taking the future one on faith is the worse of the two errors.
  if (Math.abs(now - sampledAt) > HOST_PRESSURE_FILE_MAX_AGE_MS) {
    return null;
  }
  if (!Number.isFinite(file.busyPercent) || file.busyPercent < 0 || file.busyPercent > 100) {
    return null;
  }
  return file.busyPercent / 100;
}

/**
 * Busiest AMD card's utilization from DRM sysfs, in [0,1], or `null` when nothing could be read.
 *
 * `device/gpu_busy_percent` is the amdgpu driver's own duty-cycle counter — the one number on this
 * fleet that actually answers "is this GPU committed right now", independent of who committed it.
 * Cards are combined with `max`, not a mean: one saturated card is a saturated node for the next
 * request, and averaging would let a second idle card hide it.
 *
 * Read with plain `node:fs` from a compile-time constant root plus a regex-filtered basename,
 * deliberately NOT through `FilesystemService` — widening that security-critical allowlist for a
 * metrics read would be the expensive part of a cheap feature. Every failure mode (no mount, no
 * directory, no such attribute, a non-AMD card, an unreadable file) returns `null`, which the
 * sampler treats as "no sample", which ages the band out to unmeasured.
 */
export async function readAmdDrmOccupancy(sysfsRoot: string = HOST_SYSFS_ROOT): Promise<number | null> {
  const drmRoot = path.join(sysfsRoot, 'class', 'drm');
  let entries: string[];
  try {
    entries = await fs.promises.readdir(drmRoot);
  } catch {
    return null;
  }

  let busiest: number | null = null;
  for (const entry of entries) {
    if (!DRM_CARD_DIR.test(entry)) {
      continue;
    }
    const percent = await readBusyPercent(path.join(drmRoot, entry, 'device', 'gpu_busy_percent'));
    if (percent === null) {
      continue;
    }
    busiest = Math.max(busiest ?? 0, percent / 100);
  }
  return busiest;
}

/** One `gpu_busy_percent` attribute. Anything that is not an in-range integer is treated as absent, never as 0. */
async function readBusyPercent(filePath: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const percent = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}
