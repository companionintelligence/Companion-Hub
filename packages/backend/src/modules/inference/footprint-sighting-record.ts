import fs from 'node:fs';
import path from 'node:path';
import { INFERENCE_BACKEND_TYPES, type HardwareProfile, type InferenceBackendType } from '@ci-hub/common/types';
import { DATA_DIR } from '@/common/constants';
import type { FootprintSighting } from './context-length.util';

/**
 * What each model was last measured occupying on this node, kept on disk so a Hub restart does not
 * forget it.
 *
 * `MemoryManagerService` records a {@link FootprintSighting} whenever it measures a model resident,
 * and the fit check, the pin check and the app handouts prefer it to the catalog's figure. Held only
 * in memory, every Hub restart and fleet roll threw them away, and a model that had since expired
 * from the engine was sized from the catalog again: gemma4:e4b at 10,813 MB, which the 8 and 10 GB
 * cards serving it in 5,550 MiB then refused to pin or load, and whose handout fell from 16384 to 4096
 * until something loaded it again.
 *
 * A sighting is only good for the card it was taken on, so the file names the hardware it was
 * measured on ({@link sightingHardware}); a file from other hardware is ignored and replaced.
 */
export const FOOTPRINT_SIGHTINGS_PATH = path.join(DATA_DIR, 'state', 'inference-footprint-sightings.json');

export interface RecordedSighting extends FootprintSighting {
  backend: InferenceBackendType;
  /** The engine's own id for the model, as it was resident. */
  model: string;
  /** When it was last measured, for whoever reads the file; nothing expires on it. */
  seenAt: string;
}

export interface RecordedSightings {
  hardware: string;
  sightings: RecordedSighting[];
}

/**
 * The hardware a sighting holds for: the pool models load into, and the device and its size. Sizes
 * are whole GiB so a driver or kernel update that moves the reported total by a few MB does not throw
 * the measurements away; a different card does.
 */
export function sightingHardware(profile: HardwareProfile): string {
  const onCard = profile.gpu.available && !profile.gpu.unifiedMemory;
  const sizeMb = onCard ? profile.gpu.vramMb : profile.ram.totalMb;
  return [onCard ? 'vram' : 'ram', profile.gpu.vendor, profile.gpu.model, `${Math.round(sizeMb / 1024)}GiB`].join('|');
}

function isRecordedSighting(value: unknown): value is RecordedSighting {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  const positive = (field: unknown) => typeof field === 'number' && Number.isFinite(field) && field > 0;
  return (
    typeof entry.backend === 'string' &&
    (INFERENCE_BACKEND_TYPES as readonly string[]).includes(entry.backend) &&
    typeof entry.model === 'string' &&
    entry.model.length > 0 &&
    positive(entry.footprintMb) &&
    positive(entry.contextLength) &&
    (entry.source === 'process' || entry.source === 'engine') &&
    typeof entry.seenAt === 'string'
  );
}

/** The persisted sightings, or null for a file that is missing, unreadable or not this shape. */
export async function readFootprintSightings(file = FOOTPRINT_SIGHTINGS_PATH): Promise<RecordedSightings | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.hardware !== 'string' || !Array.isArray(record.sightings)) return null;
  return { hardware: record.hardware, sightings: record.sightings.filter(isRecordedSighting) };
}

export async function writeFootprintSightings(record: RecordedSightings, file = FOOTPRINT_SIGHTINGS_PATH): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a Hub killed mid-write leaves the previous file rather than a torn one.
  const temporary = `${file}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(record), 'utf8');
  await fs.promises.rename(temporary, file);
}

/**
 * Whether `next` is worth writing over `previous`. A resident model's process figure moves by a few
 * MB between samples, and the budget is measured every few seconds under pool traffic; rewriting the
 * file for that would be a write per request for nothing the sizing can tell apart.
 */
export function sightingMovedMaterially(previous: FootprintSighting | undefined, next: FootprintSighting): boolean {
  if (!previous) return true;
  if (previous.contextLength !== next.contextLength || previous.source !== next.source) return true;
  return Math.abs(previous.footprintMb - next.footprintMb) > Math.max(64, previous.footprintMb * 0.02);
}
