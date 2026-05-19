/**
 * Canonical compatibility & naming contracts for CI-Hub.
 *
 * This module is the single vocabulary for expressing:
 *  - What an app requires from the Hub to run (`AppCompatibility`).
 *  - What a Hub instance can provide (`HubCompatibility`).
 *  - How to compare the two (`checkAppCompatibility`).
 *
 * ## Naming convention
 * The legacy Runtipi field name `tipi_version` is treated as a legacy alias.
 * The canonical field name is `hub_version`. Translation happens at ingestion
 * time in the marketplace layer — nothing downstream should see `tipi_version`.
 */

import { z } from 'zod';
import { ARCHITECTURES } from './app-info.js';

// ─── AppCompatibility ─────────────────────────────────────────────────────────

/**
 * What an app declares about its Hub compatibility requirements.
 *
 * This is the canonical form after ingestion-time normalisation. The on-disk
 * `config.json` format uses `tipi_version` (legacy Runtipi key), which is
 * translated to `hub_version` by `extractAppCompatibility()` below.
 */
export const appCompatibilitySchema = z.object({
  /**
   * Hub manifest schema version (integer, monotonically increasing).
   * Canonical key: `hub_version`. Legacy key: `tipi_version`.
   */
  hub_version: z.number().int().positive(),

  /**
   * CPU architectures this app image supports.
   * Absent in legacy configs is treated as all-supported by convention.
   */
  supported_architectures: z.enum(ARCHITECTURES).array().min(1).default(['amd64', 'arm64']),

  /**
   * Minimum Hub semver the app requires (e.g. "1.2.0").
   * Absent = no minimum constraint.
   */
  min_hub_version: z.string().optional(),
});

export type AppCompatibility = z.output<typeof appCompatibilitySchema>;
export type AppCompatibilityInput = z.input<typeof appCompatibilitySchema>;

// ─── HubCompatibility ─────────────────────────────────────────────────────────

/**
 * What this Hub instance can provide.
 * Used as the "right-hand side" of compatibility checks.
 */
export const hubCompatibilitySchema = z.object({
  /**
   * Semver of the running Hub (e.g. "1.2.3").
   * Sourced from the Hub's own `package.json` version at startup.
   */
  hub_version: z.string(),

  /**
   * CPU architectures the current host supports.
   * Typically `['amd64']` on Intel/AMD, `['arm64']` on Apple Silicon / Raspberry Pi,
   * or `['amd64', 'arm64']` when emulation (binfmt / Rosetta) is available.
   */
  architectures: z.enum(ARCHITECTURES).array().min(1),
});

export type HubCompatibility = z.output<typeof hubCompatibilitySchema>;

// ─── Compatibility check ──────────────────────────────────────────────────────

/**
 * Check whether an app's compatibility requirements are satisfied by this Hub.
 *
 * @returns `null` when the app is compatible, or a human-readable reason string
 *   when it is not.
 *
 * @example
 * ```ts
 * const reason = checkAppCompatibility(app, hub);
 * if (reason) showWarning(`Cannot install: ${reason}`);
 * ```
 */
export function checkAppCompatibility(app: AppCompatibility, hub: HubCompatibility): string | null {
  // Architecture check: at least one of the app's supported architectures must
  // be present in the Hub's architecture list.
  const hasMatchingArch = app.supported_architectures.some((arch) => hub.architectures.includes(arch));
  if (!hasMatchingArch) {
    const appArchs = app.supported_architectures.join(' or ');
    const hubArchs = hub.architectures.join(', ');
    return `Requires ${appArchs} but Hub runs on ${hubArchs}`;
  }

  // Minimum Hub version check
  if (app.min_hub_version) {
    if (!meetsMinVersion(hub.hub_version, app.min_hub_version)) {
      return `Requires Hub ≥ ${app.min_hub_version} (running ${hub.hub_version})`;
    }
  }

  return null;
}

/**
 * Semver ≥ comparison: returns `true` if `running` satisfies `required`.
 *
 * Handles the common `vX.Y.Z` prefix (leading non-numeric characters are
 * stripped). Major version mismatches are treated as incompatible (breaking
 * changes assumed).
 *
 * This is intentionally minimal — the Hub only uses this for its own version
 * constraints. For complex semver ranges, use a dedicated semver library.
 */
export function meetsMinVersion(running: string, required: string): boolean {
  const toTuple = (v: string): [number, number, number] => {
    const parts = v
      .replace(/^[^\d]*/, '') // strip leading non-digits (e.g. "v1.0.0" → "1.0.0")
      .split('.')
      .map(Number);
    const [maj = 0, min = 0, patch = 0] = parts;
    return [maj, min, patch];
  };

  const [rMaj, rMin, rPatch] = toTuple(running);
  const [qMaj, qMin, qPatch] = toTuple(required);

  if (rMaj !== qMaj) return rMaj > qMaj;
  if (rMin !== qMin) return rMin > qMin;
  return rPatch >= qPatch;
}

// ─── Legacy translation ───────────────────────────────────────────────────────
//
// The on-disk app `config.json` format (inherited from Runtipi) uses the key
// `tipi_version` for the manifest schema version. This seam is the *only* place
// where that key should appear; all domain code should use `hub_version`.

/** The legacy on-disk key name for the manifest schema version. */
export const LEGACY_TIPI_VERSION_KEY = 'tipi_version' as const;

/**
 * Extract `AppCompatibilityInput` from a raw parsed `config.json` object,
 * normalising the legacy `tipi_version` key to `hub_version`.
 *
 * Use this at marketplace / app-store ingestion time. Downstream code should
 * receive and store `hub_version` only.
 *
 * @example
 * ```ts
 * // In MarketplaceService.getAppInfo():
 * const compat = appCompatibilitySchema.parse(extractAppCompatibility(rawConfig));
 * ```
 */
export function extractAppCompatibility(raw: Record<string, unknown>): AppCompatibilityInput {
  // Prefer the canonical key if present; fall back to the legacy key; default to 1.
  const hub_version =
    typeof raw.hub_version === 'number'
      ? raw.hub_version
      : typeof raw[LEGACY_TIPI_VERSION_KEY] === 'number'
        ? (raw[LEGACY_TIPI_VERSION_KEY] as number)
        : 1;

  return {
    hub_version,
    supported_architectures: raw.supported_architectures as AppCompatibilityInput['supported_architectures'] | undefined,
    min_hub_version: typeof raw.min_hub_version === 'string' ? raw.min_hub_version : undefined,
  };
}
