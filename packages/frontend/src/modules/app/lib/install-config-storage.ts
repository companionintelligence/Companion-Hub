import { hiddenTypes } from '@/modules/app/components/install-form/form-validators';
import type { FormField } from '@/types/app.types';

/**
 * Field types whose values must never be written to disk or persistent browser storage in
 * plaintext.
 *
 * - `password`: renders a masked `PasswordInput` control in `install-form-field.tsx` — visible
 *   and editable, but never in cleartext.
 * - Every type in `hiddenTypes` (currently just `random`): the catalog schema's marker for
 *   auto-generated credentials (e.g. nextcloud's `NEXTCLOUD_DB_PASSWORD`, keila's
 *   `SECRET_KEY_BASE`/`POSTGRES_PASSWORD`). The install form never renders or lets an operator
 *   edit these, so a live value for one is exactly as sensitive as a `password` field even though
 *   its declared `type` isn't literally `'password'`.
 *
 * Reuses `hiddenTypes` from `form-validators.ts` (the CREATE-form's own "don't render/validate
 * this field" list) instead of hand-rolling a second, independent list of secret types — the two
 * drifting apart is exactly what let live `random`-type secrets (e.g. database passwords) leak
 * into the Edit Settings export/"recently used" flows in CI-Hub #972.
 */
export const SECRET_FIELD_TYPES: readonly string[] = ['password', ...hiddenTypes];

export function isSecretFieldType(type: string): boolean {
  return SECRET_FIELD_TYPES.includes(type);
}

function secretEnvVariables(formFields: FormField[]): Set<string> {
  return new Set(formFields.filter((field) => isSecretFieldType(field.type)).map((field) => field.env_variable));
}

/**
 * Returns a shallow copy of `values` with every field the current app declares as a secret
 * (`type: 'password'`) removed. Used before BOTH export-to-file and the "last used" localStorage
 * cache — neither must ever contain a credential in plaintext.
 */
export function stripSecretFields(values: Record<string, unknown>, formFields: FormField[]): Record<string, unknown> {
  const secretKeys = secretEnvVariables(formFields);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (secretKeys.has(key)) continue;
    result[key] = value;
  }
  return result;
}

export interface InstallConfigExport {
  /** Lets future versions evolve this payload shape without breaking older exported files. */
  schemaVersion: 1;
  appId: string;
  exportedAt: string;
  values: Record<string, unknown>;
}

/** Filename used for the downloadable export, e.g. `nextcloud-install-config.json`. */
export function installConfigFilename(appId: string): string {
  const safeAppId = appId.replace(/[^a-zA-Z0-9._-]/g, '-') || 'app';
  return `${safeAppId}-install-config.json`;
}

export function buildInstallConfigExport(appId: string, values: Record<string, unknown>, formFields: FormField[]): InstallConfigExport {
  return {
    schemaVersion: 1,
    appId,
    exportedAt: new Date().toISOString(),
    values: stripSecretFields(values, formFields),
  };
}

/** Pretty-printed JSON string for the downloadable file. */
export function serializeInstallConfig(appId: string, values: Record<string, unknown>, formFields: FormField[]): string {
  return JSON.stringify(buildInstallConfigExport(appId, values, formFields), null, 2);
}

export type ImportInstallConfigResult =
  | { ok: true; values: Record<string, unknown>; recognizedKeys: string[]; unrecognizedKeys: string[] }
  | { ok: false; error: 'INVALID_JSON' | 'INVALID_SHAPE' };

/**
 * Parses a previously-exported install config and restricts it to keys that match the CURRENT
 * app's `form_fields`. Keys that don't match a known `env_variable` are reported back in
 * `unrecognizedKeys`, not applied — this is what stops an operator who imports a config exported
 * for a different app from silently corrupting unrelated form state.
 */
export function parseInstallConfigJson(json: string, formFields: FormField[]): ImportInstallConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'INVALID_JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'INVALID_SHAPE' };
  }

  // Tolerate both the wrapped `{ values: {...} }` shape this module writes and a bare key/value
  // file (e.g. hand-edited, or exported by a future/older version of this tool).
  const rawValues = (parsed as { values?: unknown }).values;
  const candidateValues =
    rawValues && typeof rawValues === 'object' && !Array.isArray(rawValues)
      ? (rawValues as Record<string, unknown>)
      : (parsed as Record<string, unknown>);

  const knownEnvVars = new Set(formFields.map((field) => field.env_variable));
  const values: Record<string, unknown> = {};
  const recognizedKeys: string[] = [];
  const unrecognizedKeys: string[] = [];

  for (const [key, value] of Object.entries(candidateValues)) {
    if (knownEnvVars.has(key)) {
      values[key] = value;
      recognizedKeys.push(key);
    } else {
      unrecognizedKeys.push(key);
    }
  }

  return { ok: true, values, recognizedKeys, unrecognizedKeys };
}

export const LAST_USED_CONFIGS_KEY_PREFIX = 'ci-hub:last-install-configs:';
export const MAX_LAST_USED_CONFIGS = 5;

export interface LastUsedInstallConfig {
  id: string;
  savedAt: string;
  values: Record<string, unknown>;
}

function lastUsedStorageKey(appStoreSlug: string): string {
  return `${LAST_USED_CONFIGS_KEY_PREFIX}${appStoreSlug}`;
}

/** Storage is injectable for tests; defaults to `window.localStorage` in the browser. */
function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

function isLastUsedInstallConfig(entry: unknown): entry is LastUsedInstallConfig {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Partial<LastUsedInstallConfig>;
  return typeof candidate.id === 'string' && typeof candidate.savedAt === 'string' && !!candidate.values && typeof candidate.values === 'object';
}

/** Reads the "recently used" list for one app-store slug, newest first. Never throws. */
export function readLastUsedConfigs(appStoreSlug: string, storage?: Storage): LastUsedInstallConfig[] {
  const store = resolveStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(lastUsedStorageKey(appStoreSlug));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLastUsedInstallConfig);
  } catch {
    return [];
  }
}

/**
 * Records a successful install submission to the client-side "recently used" cache, stripping any
 * declared secret fields first (see `stripSecretFields`) — this cache is plain localStorage, so
 * nothing that must not hit disk in plaintext may enter it. Keeps at most
 * `MAX_LAST_USED_CONFIGS` entries, newest first.
 */
export function recordLastUsedConfig(
  appStoreSlug: string,
  values: Record<string, unknown>,
  formFields: FormField[],
  storage?: Storage,
): LastUsedInstallConfig[] {
  const store = resolveStorage(storage);
  const entry: LastUsedInstallConfig = {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    savedAt: new Date().toISOString(),
    values: stripSecretFields(values, formFields),
  };

  const next = [entry, ...readLastUsedConfigs(appStoreSlug, storage)].slice(0, MAX_LAST_USED_CONFIGS);

  if (store) {
    try {
      store.setItem(lastUsedStorageKey(appStoreSlug), JSON.stringify(next));
    } catch {
      // Storage may be unavailable or full (private browsing, quota). The caller still gets `next`
      // back so the UI can show the new entry for this session even if persistence silently failed.
    }
  }

  return next;
}

/** Clears the "recently used" cache for one app-store slug. */
export function clearLastUsedConfigs(appStoreSlug: string, storage?: Storage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(lastUsedStorageKey(appStoreSlug));
  } catch {
    // ignore
  }
}
