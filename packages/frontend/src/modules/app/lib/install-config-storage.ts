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

const isBoolean = (value: unknown) => typeof value === 'boolean';
const isString = (value: unknown) => typeof value === 'string';

/**
 * The access settings the install dialog adds to every exposable app's own `form_fields`, each with
 * the kind of value the dialog holds for it. They travel in an exported config like the app's
 * fields do, but go back only into the app that wrote the file: another app's port and subdomain
 * describe that app. Whether the port or subdomain is still free where the file is imported is for
 * the Hub's install checks to say, not the importer.
 *
 * The value check matters most for `exposureMode`: the form submits a mode it does not know as the
 * first one available, which is Public Web on a Hub that has it.
 */
const ACCESS_SETTINGS = new Map<string, (value: unknown) => boolean>([
  ['exposureMode', (value) => value === 'local' || value === 'cloudflare' || value === 'tailscale'],
  ['localSubdomain', isString],
  ['publicDomain', isString],
  ['enableAuth', isBoolean],
  ['exposedLocal', isBoolean],
  ['openPort', isBoolean],
  ['port', (value) => isString(value) || typeof value === 'number'],
]);

function isAccessSetting(key: string, value: unknown): boolean {
  return ACCESS_SETTINGS.get(key)?.(value) ?? false;
}

/**
 * Values that hold only for the dialog they were drawn in. `customDomainExpected` is the custom
 * domain the app was served on when the dialog opened, seeded from the installed app so the Hub can
 * refuse a save made against a stale view. `customDomainTakeover` is the operator's answer to the
 * picker's "move this domain here?", which the Hub spends on one move. Carried in from a file or an
 * earlier install, either would describe some other moment, and a stale takeover would move a
 * domain off another app without asking.
 */
const DIALOG_ONLY_KEYS = new Set(['customDomainExpected', 'customDomainTakeover']);

function withoutDialogOnlyKeys(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !DIALOG_ONLY_KEYS.has(key)));
}

/**
 * The app's own fields a config file may set. Hidden types (`random`, the generated credentials)
 * are left out: the form never shows or edits them, and on Edit Settings a value from a file would
 * replace the secret the app's data was created with.
 */
function appFieldKeys(formFields: FormField[]): Set<string> {
  const hidden: readonly string[] = hiddenTypes;
  return new Set(formFields.filter((field) => !hidden.includes(field.type)).map((field) => field.env_variable));
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

/**
 * Writes only what `parseInstallConfigJson` applies, so a file imports with nothing ignored. The
 * dialog's other values (the custom domain picker, Advanced Mode's backup limit, CPU limit and
 * guest dashboard switch) stay out.
 */
export function buildInstallConfigExport(appId: string, values: Record<string, unknown>, formFields: FormField[]): InstallConfigExport {
  const appFields = appFieldKeys(formFields);
  return {
    schemaVersion: 1,
    appId,
    exportedAt: new Date().toISOString(),
    values: Object.fromEntries(
      Object.entries(stripSecretFields(values, formFields)).filter(([key, value]) => appFields.has(key) || isAccessSetting(key, value)),
    ),
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
 * app's `form_fields`, plus the `ACCESS_SETTINGS` when the file's `appId` is this app's and the
 * value is one the dialog can hold. Everything else is reported back in `unrecognizedKeys`, not
 * applied. That is what stops an operator who imports a config exported for a different app from
 * silently corrupting unrelated form state.
 *
 * `customDomainExpected` and `customDomainTakeover`, which older exports wrote, are dropped
 * without a report.
 */
export function parseInstallConfigJson(json: string, formFields: FormField[], appId: string): ImportInstallConfigResult {
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

  const appFields = appFieldKeys(formFields);
  const fromThisApp = (parsed as { appId?: unknown }).appId === appId;
  const values: Record<string, unknown> = {};
  const recognizedKeys: string[] = [];
  const unrecognizedKeys: string[] = [];

  for (const [key, value] of Object.entries(withoutDialogOnlyKeys(candidateValues))) {
    if (appFields.has(key) || (fromThisApp && isAccessSetting(key, value))) {
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
    // Entries saved before `recordLastUsedConfig` dropped the dialog-only keys still hold them.
    return parsed.filter(isLastUsedInstallConfig).map((entry) => ({ ...entry, values: withoutDialogOnlyKeys(entry.values) }));
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
    values: withoutDialogOnlyKeys(stripSecretFields(values, formFields)),
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
