import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '@/common/constants';

/**
 * What an app was last actually handed over `bootstrap.env`, kept so the staleness check can tell
 * whether the app holds what the Hub would hand it now.
 *
 * It is written to disk because the app outlives the Hub process. App containers keep running
 * through a Hub restart or auto-update and fetch `bootstrap.env` only when they start, so a record
 * kept in memory is gone for exactly the apps that did not restart. Every such app then read as
 * stale, and the next inference refresh restarted it for nothing.
 *
 * Env values are stored as SHA-256 digests, never as values: a handout carries the operator's cloud
 * provider API keys, and equality is the only question this record answers.
 */
export interface RecordedHandout {
  servedAt: string;
  routedThroughPool: boolean;
  chatModelId: string | null;
  chatModelError: string | null;
  endpointUrl: string;
  managedKeys: string[];
  envDigests: Record<string, string>;
}

/** The fields of a handout a record is built from. */
export interface HandoutSource {
  routedThroughPool: boolean;
  chatModelId: string | null;
  chatModelError: string | null;
  endpointUrl: string;
  managedKeys: string[];
  env: Record<string, string>;
}

export const HANDOUT_RECORDS_PATH = path.join(DATA_DIR, 'state', 'inference-handouts.json');

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function digestEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, digest(value)]));
}

export function handoutRecord(source: HandoutSource, servedAt: string): RecordedHandout {
  return {
    servedAt,
    routedThroughPool: source.routedThroughPool,
    chatModelId: source.chatModelId,
    chatModelError: source.chatModelError,
    endpointUrl: source.endpointUrl,
    managedKeys: [...source.managedKeys],
    envDigests: digestEnv(source.env),
  };
}

/** Managed env keys whose value differs between a recorded handout and the one the Hub would serve now. */
export function differingHandoutKeys(recorded: RecordedHandout, current: Pick<HandoutSource, 'env' | 'managedKeys'>): string[] {
  const now = digestEnv(current.env);
  const keys = new Set([...recorded.managedKeys, ...current.managedKeys]);
  return [...keys].filter((key) => (recorded.envDigests[key] ?? null) !== (now[key] ?? null)).sort();
}

function isRecordedHandout(value: unknown): value is RecordedHandout {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const nullableString = (field: unknown) => field === null || typeof field === 'string';
  return (
    typeof record.servedAt === 'string' &&
    typeof record.routedThroughPool === 'boolean' &&
    nullableString(record.chatModelId) &&
    nullableString(record.chatModelError) &&
    typeof record.endpointUrl === 'string' &&
    Array.isArray(record.managedKeys) &&
    record.managedKeys.every((key) => typeof key === 'string') &&
    Boolean(record.envDigests) &&
    typeof record.envDigests === 'object' &&
    Object.values(record.envDigests as object).every((entry) => typeof entry === 'string')
  );
}

/** The persisted records by app slug. A missing or unreadable file is no records, not an error. */
export async function readHandoutRecords(file = HANDOUT_RECORDS_PATH): Promise<Record<string, RecordedHandout>> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, RecordedHandout] => isRecordedHandout(entry[1])));
}

export async function writeHandoutRecords(records: Record<string, RecordedHandout>, file = HANDOUT_RECORDS_PATH): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename so a Hub killed mid-write leaves the previous file rather than a torn one.
  const temporary = `${file}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(records), 'utf8');
  await fs.promises.rename(temporary, file);
}
