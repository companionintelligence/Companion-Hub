/**
 * Error-reporting consent — the single source of truth for whether a Sentry
 * event is allowed to leave this appliance.
 *
 * Reporting is **opt-out**: on wherever a DSN is configured, and the user turns
 * it off with the "Allow error monitoring" switch in Settings. That switch used
 * to be decorative — `allowErrorMonitoring` was read and discarded, and
 * `ConfigurationService.configure()` hardcoded it back to `true` on every boot —
 * so a documented privacy control had no effect. This module is what makes it
 * authoritative.
 *
 * Precedence, highest first:
 *
 *   1. `CI_LOCAL_ONLY=true` — local-only mode must mean zero phone-home.
 *   2. `CI_TELEMETRY=off`   — operator kill switch, applies even to a DSN baked
 *                             into a release image.
 *   3. `allowErrorMonitoring` in `state/settings.json` — the user's own choice.
 *   4. No `SENTRY_DSN` — nothing to send to.
 *
 * The user's choice is consulted from `beforeSend`, not only at init, so
 * flipping the switch takes effect in the same tick without a Hub restart —
 * in both directions. The two env switches are static for the process lifetime
 * and are additionally enforced at init, so an opted-out process never even
 * constructs a transport.
 *
 * Reads FAIL CLOSED: a `state/settings.json` we cannot read or cannot parse
 * disables reporting. A *missing* file is different — that is a fresh appliance
 * that has not been configured yet, not a decision we failed to read — and
 * takes the opt-out default (enabled).
 */

import fs from 'node:fs';
import path from 'node:path';
// Relative, not the `@/` alias: this module is pulled in by `instrument.ts`,
// which runs before anything else in the process and deliberately avoids the
// alias-resolving import graph.
import { DATA_DIR } from '../../common/constants';

/**
 * Wire-compatible with the fleet's `GET /api/config/telemetry` contract
 * (CI-Server, Companion-Planning, CI-Spellbook, CI-Spatial-Companion-WebXR).
 * `user-disabled` and `settings-unreadable` are Hub-specific additions — no
 * other component in the fleet has a per-user switch.
 */
export type TelemetryDisabledReason = 'local-only' | 'opt-out' | 'user-disabled' | 'settings-unreadable' | 'no-dsn';

export interface TelemetryDecision {
  enabled: boolean;
  reason: TelemetryDisabledReason | null;
}

/**
 * `unset` = the user has expressed no preference (fresh install / key absent),
 * which under an opt-out posture means enabled. `unreadable` = we tried and
 * failed, which means disabled.
 */
export type UserConsent = boolean | 'unset' | 'unreadable';

const FALSEY = new Set(['off', 'false', '0', 'no', 'disabled']);
const TRUTHY = new Set(['on', 'true', '1', 'yes', 'enabled']);

/** How long a disk-read consent value is trusted before it is re-read. */
export const CONSENT_CACHE_TTL_MS = 1_000;

function read(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();

  return value ? value : null;
}

/** `CI_TELEMETRY=off` (any falsey spelling) opts out; anything else leaves the DSN in charge. */
export function isTelemetryOptedOut(env: NodeJS.ProcessEnv): boolean {
  const value = read(env, 'CI_TELEMETRY')?.toLowerCase();

  return value !== null && value !== undefined && FALSEY.has(value);
}

/** Local-only mode forbids all egress, telemetry included. */
export function isLocalOnly(env: NodeJS.ProcessEnv): boolean {
  const value = read(env, 'CI_LOCAL_ONLY')?.toLowerCase();

  return value !== null && value !== undefined && TRUTHY.has(value);
}

/**
 * The env-level half of the decision. Static for the lifetime of the process,
 * so callers may evaluate it once at init and skip `Sentry.init` entirely.
 */
export function envTelemetryBlock(env: NodeJS.ProcessEnv = process.env): 'local-only' | 'opt-out' | null {
  if (isLocalOnly(env)) {
    return 'local-only';
  }

  if (isTelemetryOptedOut(env)) {
    return 'opt-out';
  }

  return null;
}

/** Absolute path of the settings file that backs the consent switch. */
export function settingsFilePath(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'state', 'settings.json');
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Read `allowErrorMonitoring` straight off disk.
 *
 * Deliberately synchronous and dependency-free: the callers are `beforeSend`
 * (which cannot await) and `instrument.ts` (which runs before Nest exists, so
 * `ConfigurationService` is not available).
 */
export function readUserConsentFrom(settingsPath: string = settingsFilePath()): UserConsent {
  let raw: string;

  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (error) {
    // No settings file yet = a fresh appliance, not a failed read. Anything
    // else (EACCES after a UID change, EIO) is a decision we could not read.
    return isMissingFile(error) ? 'unset' : 'unreadable';
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unreadable';
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'unreadable';
  }

  const value = (parsed as Record<string, unknown>).allowErrorMonitoring;

  if (value === undefined || value === null) {
    return 'unset';
  }

  // A non-boolean here means the file was hand-edited or written by something
  // that does not respect the schema. Do not guess what the user meant.
  return typeof value === 'boolean' ? value : 'unreadable';
}

let cache: { value: UserConsent; expiresAt: number } | null = null;

/**
 * Publish the user's choice the moment it is written, so a flip is live in the
 * same tick rather than after the cache TTL. Called by
 * `ConfigurationService.setUserSettings`.
 */
export function setUserConsent(value: UserConsent, now: number = Date.now()): void {
  cache = { value, expiresAt: now + CONSENT_CACHE_TTL_MS };
}

/** Drop the memoised value. Exposed for tests and for post-restore invalidation. */
export function resetUserConsentCache(): void {
  cache = null;
}

/**
 * The user's current choice, memoised for {@link CONSENT_CACHE_TTL_MS} so a
 * burst of captures (a crash loop, a failing watchdog) cannot turn into a
 * `readFileSync` per event.
 */
export function currentUserConsent(now: number = Date.now(), settingsPath?: string): UserConsent {
  if (cache && now < cache.expiresAt) {
    return cache.value;
  }

  const value = readUserConsentFrom(settingsPath ?? settingsFilePath());
  cache = { value, expiresAt: now + CONSENT_CACHE_TTL_MS };

  return value;
}

export interface ConsentDecisionOptions {
  env?: NodeJS.ProcessEnv;
  consent?: UserConsent;
}

/**
 * Kill switches + the user's switch, with no DSN dimension.
 *
 * This is what `GET /api/config/telemetry` answers with: the browser bundle and
 * the desktop shell carry their own DSNs (`VITE_SENTRY_DSN`,
 * `SENTRY_DESKTOP_DSN`), so answering `no-dsn` on the strength of the backend's
 * `SENTRY_DSN` would wrongly silence a client that has one.
 */
export function resolveConsentDecision(options: ConsentDecisionOptions = {}): TelemetryDecision {
  const env = options.env ?? process.env;
  const blocked = envTelemetryBlock(env);

  if (blocked) {
    return { enabled: false, reason: blocked };
  }

  const consent = options.consent ?? currentUserConsent();

  if (consent === 'unreadable') {
    return { enabled: false, reason: 'settings-unreadable' };
  }

  if (consent === false) {
    return { enabled: false, reason: 'user-disabled' };
  }

  return { enabled: true, reason: null };
}

export interface TelemetryDecisionOptions extends ConsentDecisionOptions {
  /** The caller's own DSN. Absent/blank ⇒ `no-dsn`. */
  dsn?: string | null;
}

/** The full decision for a component that owns a DSN (the backend). */
export function resolveTelemetryDecision(options: TelemetryDecisionOptions = {}): TelemetryDecision {
  const decision = resolveConsentDecision(options);

  if (!decision.enabled) {
    return decision;
  }

  return options.dsn?.trim() ? { enabled: true, reason: null } : { enabled: false, reason: 'no-dsn' };
}

/**
 * The `beforeSend` gate. Re-evaluated per event on purpose — this is what makes
 * a mid-session opt-out stop the very next capture without a restart.
 */
export function isReportingAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveConsentDecision({ env }).enabled;
}
