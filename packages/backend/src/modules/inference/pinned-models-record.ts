import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';

/**
 * The catalog models the operator pinned on this node, kept on disk so a Hub restart does not unpin
 * them.
 *
 * A pin is the operator's word that a model stays in memory. The engine keeps its side across a Hub
 * restart (Ollama holds a pinned model at `keep_alive: -1` until it is told otherwise), but the Hub
 * held its side only in memory: after a restart or a fleet roll the model the operator pinned was
 * still resident, the new Hub process knew nothing of the pin, and the next operator load that needed
 * room could unload it (PIN-2 in the audit of #1679).
 *
 * Catalog ids, not engine ids: a pin is made on a catalog row (`pinTrackedModel`), and the row says
 * which engine serves it and under what name. Kept in a state file beside the footprint sightings
 * rather than in `settings.json`, because an older Hub build that saves settings drops every key it
 * does not declare, and a node rolled back to one would lose its pins at the first settings write.
 */
export const PINNED_MODELS_PATH = path.join(DATA_DIR, 'state', 'inference-pinned-models.json');

export interface PinnedModelsRecord {
  /** Catalog ids, in the order they were pinned. */
  pinned: string[];
}

/** The persisted pins, or null for a file that is missing, unreadable or not this shape. */
export async function readPinnedModels(file = PINNED_MODELS_PATH): Promise<PinnedModelsRecord | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const pinned = (parsed as Record<string, unknown>).pinned;
  if (!Array.isArray(pinned)) return null;
  return { pinned: [...new Set(pinned.filter((id): id is string => typeof id === 'string' && id.length > 0))] };
}

export async function writePinnedModels(record: PinnedModelsRecord, file = PINNED_MODELS_PATH): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a Hub killed mid-write leaves the previous file rather than a torn one.
  const temporary = `${file}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(record), 'utf8');
  await fs.promises.rename(temporary, file);
}
