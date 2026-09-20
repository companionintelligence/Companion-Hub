import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';
import { canonicalTimeZone } from '@/common/helpers/timezone-helpers';
import { optionalCpuLimitSchema } from '@/common/validation/cpu-limit';
import { optionalMemoryLimitSchema } from '@/common/validation/memory-limit';
import {
  MAX_POOL_HEALTH_POLL_SECONDS,
  MAX_POOL_LOCAL_AFFINITY,
  MAX_POOL_MAX_PROMPT_TOKENS,
  MAX_POOL_PRESSURE_WEIGHT,
  MAX_POOL_PROBE_SNAPSHOT_TTL_MS,
  MIN_POOL_HEALTH_POLL_SECONDS,
  MIN_POOL_LOCAL_AFFINITY,
  MIN_POOL_MAX_PROMPT_TOKENS,
  MIN_POOL_PRESSURE_WEIGHT,
  MIN_POOL_PROBE_SNAPSHOT_TTL_MS,
  MAX_POOL_PINS,
  MAX_PINNED_MODEL_LENGTH,
  POOL_PIN_MODES,
  POOL_PIN_SCOPES,
  POOL_PIN_TARGET_KINDS,
} from '@/common/helpers/hub-pool';
import { INFERENCE_SUPERVISION_MODES, MAX_SUPERVISION_POLL_SECONDS, MIN_SUPERVISION_POLL_SECONDS } from '@/common/helpers/inference-supervision';

import { INFERENCE_BACKEND_TYPES } from '@ci-hub/common/types';
import { userSchema } from './modules/user/dto/user.dto';

import { LOG_LEVEL_ENUM } from './core/logger/logger.service';
import { appInfoObjectSchema } from '@ci-hub/common/schemas';

/**
 * Bounds for the two numeric Hub Pool knobs, declared once so the read and the write path cannot
 * drift apart. They are applied strictly on the write path (`UserSettingsBody`) and with
 * `.catch(undefined)` on the read path (`settingsSchema`) — the same split `timeZone` already uses,
 * and for the same reason.
 *
 * `settingsSchema` parses settings.json at boot, from `generateSystemEnvFile`, before Nest exists.
 * A value that is merely out of range there must degrade to the DEFAULT_POOL_* constant, because
 * the alternative is an unrecoverable crash loop: downgrade a Hub that saved a value the older
 * build's bounds reject and the backend never starts, so the UI that would fix it never loads.
 * Rejecting on the write path keeps the 400 at the moment the value is chosen.
 */
const poolLocalAffinitySchema = z
  .union([z.number().int(), z.string().transform(Number)])
  .pipe(z.number().int().min(MIN_POOL_LOCAL_AFFINITY).max(MAX_POOL_LOCAL_AFFINITY));

const poolHealthPollSecondsSchema = z
  .union([z.number().int(), z.string().transform(Number)])
  .pipe(z.number().int().min(MIN_POOL_HEALTH_POLL_SECONDS).max(MAX_POOL_HEALTH_POLL_SECONDS));

const poolPressureWeightSchema = z
  .union([z.number().int(), z.string().transform(Number)])
  .pipe(z.number().int().min(MIN_POOL_PRESSURE_WEIGHT).max(MAX_POOL_PRESSURE_WEIGHT));

const poolProbeSnapshotTtlMsSchema = z
  .union([z.number().int(), z.string().transform(Number)])
  .pipe(z.number().int().min(MIN_POOL_PROBE_SNAPSHOT_TTL_MS).max(MAX_POOL_PROBE_SNAPSHOT_TTL_MS));

/**
 * The prompt ceiling as persisted: a number or nothing. There is no stored `null` — clearing it
 * removes the key, the way an unset inference URL is removed — so `.optional()` is the whole
 * "no ceiling" encoding here, and an out-of-range value degrades to it on the read path exactly as
 * the knobs above degrade to their defaults.
 */
const poolMaxPromptTokensSchema = z
  .union([z.number().int(), z.string().transform(Number)])
  .pipe(z.number().int().min(MIN_POOL_MAX_PROMPT_TOKENS).max(MAX_POOL_MAX_PROMPT_TOKENS));
/** Same read/write split as the two pool knobs above, for the inference observation interval. */
const inferenceSupervisionPollSecondsSchema = z
  .union([z.number().int(), z.string().transform(Number)])
  .pipe(z.number().int().min(MIN_SUPERVISION_POLL_SECONDS).max(MAX_SUPERVISION_POLL_SECONDS));

/**
 * Manual routing pins, as persisted.
 *
 * Read-path only, and `.catch(undefined)` on the whole array for the same reason the two numeric
 * knobs use it: settings.json is parsed at boot, before Nest exists, and a pin written by a build
 * that knew a mode or a scope this one does not must degrade to "no pins" rather than crash-loop a
 * Hub whose UI is the only way to fix it. The strict version is enforced on the write path by
 * `UpsertPoolPinBody`, where a bad value is a 400 at the moment it is chosen.
 */
const poolPinSchema = z
  .object({
    scope: z.enum(POOL_PIN_SCOPES),
    model: z.string().trim().min(1).max(MAX_PINNED_MODEL_LENGTH).optional(),
    targetKind: z.enum(POOL_PIN_TARGET_KINDS),
    peerId: z.string().trim().min(1).optional(),
    mode: z.enum(POOL_PIN_MODES),
  })
  .refine((pin) => (pin.scope === 'model') === (pin.model !== undefined))
  .refine((pin) => (pin.targetKind === 'peer') === (pin.peerId !== undefined));

const poolPinsSchema = z.array(poolPinSchema).max(MAX_POOL_PINS);

export const settingsSchema = z.object({
  advancedSettings: z.boolean(),
  allowAutoThemes: z.boolean(),
  allowErrorMonitoring: z.boolean(),
  appDataPath: z.string().trim(),
  appsRepoUrl: z.string().url().optional(),
  defaultAppCpuLimit: optionalCpuLimitSchema,
  defaultAppMemoryLimit: optionalMemoryLimitSchema,
  autoAllocateAppResources: z.boolean().optional(),
  // Written only by SystemUpdateService.setAutoUpdatesEnabled; declared here because every other
  // settings write rebuilds the file from this schema and strips unknown keys. Undeclared, an operator
  // who turned auto-update off got it back on the next inference or pool setting change.
  autoUpdates: z.boolean().optional(),
  demoMode: z.boolean(),
  disablePasswordReset: z.boolean(),
  dnsIp: z.string().ipv4(),
  domain: z.string().trim(),
  eventsTimeout: z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().min(1).max(120)),
  forwardAuthUrl: z.string().url(),
  guestDashboard: z.boolean(),
  internalIp: z.string().ipv4(),
  listenIp: z.string().ipv4(),
  localDomain: z.string().trim(),
  logLevel: z.enum(LOG_LEVEL_ENUM),
  maxBackups: z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().min(0).max(100)),
  persistTraefikConfig: z.boolean(),
  port: z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().min(0).max(65535)),
  postgresPort: z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().min(0).max(65535)),
  sslPort: z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().min(0).max(65535)),
  timeZone: z.string().trim(),
  experimental_insecureCookie: z.boolean().optional(),
  themeBase: z.string().optional(),
  themeColor: z.string().optional(),
  ciHubApiKey: z.string().trim().optional(),
  ciHubMoveKey: z.string().trim().optional(),
  ciHubOrganizationId: z.string().trim().optional(),
  ciHubOrganizationSlug: z.string().trim().optional(),
  ciHubOrganizationLabel: z.string().trim().optional(),
  ciHubDeviceSlug: z.string().trim().optional(),
  ciHubHubSubdomain: z.string().trim().optional(),
  inferenceBackend: z.enum(INFERENCE_BACKEND_TYPES).optional(),
  inferenceModel: z.string().trim().optional(),
  inferenceEmbeddingModel: z.string().trim().optional(),
  inferenceVisionModel: z.string().trim().optional(),
  inferenceVllmApiKey: z.string().trim().optional(),
  inferenceVllmUrl: z.string().trim().optional(),
  inferenceMtplxUrl: z.string().trim().optional(),
  inferenceDsparkUrl: z.string().trim().optional(),
  // Multi-Hub inference pooling. `hubPoolEnabled` is opt-out (absent = on) and is the in-product
  // half of the kill switch; `HUB_POOL_USER_DISABLED=true` in the environment still overrides it
  // (see resolveHubPoolEnabled). Absent numeric values fall back to the DEFAULT_POOL_* constants.
  hubPoolEnabled: z.boolean().optional(),
  // The two directional switches, both opt-out like the master above: absent means on, so an
  // untouched settings.json resolves to exactly today's behaviour on both axes.
  // `HUB_POOL_OUTBOUND_DISABLED` / `HUB_POOL_INBOUND_DISABLED` override them (resolveHubPoolDirections).
  hubPoolOutboundEnabled: z.boolean().optional(),
  hubPoolInboundEnabled: z.boolean().optional(),
  // `.catch(undefined)` is the read-path half of the split described above the two schemas: an
  // out-of-range persisted value is dropped here and resolves to the DEFAULT_POOL_* constant in
  // `getHubPoolPreferences`, instead of failing the parse that boot depends on. `UserSettingsBody`
  // re-applies the strict bounds, so choosing such a value still gets a 400.
  hubPoolLocalAffinity: poolLocalAffinitySchema.optional().catch(undefined),
  hubPoolHealthPollSeconds: poolHealthPollSecondsSchema.optional().catch(undefined),
  // Opt-IN, unlike every other pool switch: it refuses the legacy bearer-token branch, so absent
  // (and false) has to mean "keep accepting it" or upgrading one node of a fleet would strand the
  // rest. See `HubPoolPreferences.poolRequireSignedPeers`.
  hubPoolRequireSignedPeers: z.boolean().optional(),
  // Opt-OUT, like the three switches above: absent means this node publishes an aggregate container
  // rollup to its paired peers, so an untouched settings.json starts reporting on upgrade and the
  // operator is the one who turns it off. Off omits the key on the wire rather than sending zeros.
  // See `HubPoolPreferences.poolShareContainerStats` for why the default goes this way.
  hubPoolShareContainerStats: z.boolean().optional(),
  hubPoolPressureWeight: poolPressureWeightSchema.optional().catch(undefined),
  // Absent means no prompt ceiling, which routes exactly as a build without one does. See
  // `HUB_POOL_MAX_PROMPT_TOKENS_ENV_VAR` for what the ceiling is and why it is only a preference.
  hubPoolMaxPromptTokens: poolMaxPromptTokensSchema.optional().catch(undefined),
  hubPoolProbeSnapshotTtlMs: poolProbeSnapshotTtlMsSchema.optional().catch(undefined),
  // Opt-OUT: absent means every app is handed this Hub's proxy as its inference endpoint, peers or
  // not. See `HubPoolPreferences.poolRouteAppsAlways`.
  hubPoolRouteAppsAlways: z.boolean().optional(),
  // Inference-backend observation. Opt-IN, unlike the pool switches: absent means `'off'`, which is
  // the only value that costs a deployed Hub literally nothing — no timer, no probe, no boot work.
  // `CI_HUB_INFERENCE_SUPERVISION_DISABLED=true` in the environment overrides it
  // (resolveInferenceSupervisionMode). The enum has no "restart things" member by design; see
  // common/helpers/inference-supervision.ts. `.catch(undefined)` on the read path so a value written
  // by a future build degrades to the default here instead of failing the parse that boot depends on.
  inferenceSupervisionMode: z.enum(INFERENCE_SUPERVISION_MODES).optional().catch(undefined),
  inferenceSupervisionPollSeconds: inferenceSupervisionPollSecondsSchema.optional().catch(undefined),
  // Manual routing pins. Absent (and an unparseable array) means none, which routes exactly as a
  // build without pinning does.
  hubPoolPins: poolPinsSchema.optional().catch(undefined),
  inferenceCloudProviders: z
    .array(
      z.object({
        provider: z.enum(['openai', 'anthropic', 'google', 'github-copilot']),
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        defaultModel: z.string(),
        enabled: z.boolean(),
      }),
    )
    .optional(),
  // No MCP settings live here. SEC-MCP-8 moved MCP credentials into the hashed key store (Settings →
  // Security / `cihub api-key create`), and ISSUE-MCP-2's destructive gate became each key's
  // `capability` column — so neither an unrevocable second credential nor an appliance-wide authority
  // switch can be introduced through settings.json.
});

/**
 * settings.json keys that are not user settings: a module other than ConfigurationService owns the
 * route that writes each one, so they are neither reported in the app context nor accepted by
 * PATCH /user-settings. Write them with `ConfigurationService.setFileOnlySettings`.
 *
 * They still have to be declared, because every settings write re-reads the whole file through
 * `parsePersistedSettings`, and that parse strips any key it does not know. `autoUpdates` used to be
 * written straight to the file and declared nowhere, so the first unrelated write afterwards (a
 * Settings page save, the telemetry switch, inference preferences, a cloud provider, a pool pin, or
 * the Portal pairing callback) stripped it, and the daily auto-updater reads a missing key as "on".
 * Auto-update was switched off through that route on all 16 fleet Hubs on 2026-09-17, so the first
 * such write on any of them would have turned it back on.
 */
const fileOnlySettingsSchema = z.object({
  // Opt-out: absent means on. Owned by POST /api/system/update/auto-updates and the
  // `hub_set_auto_updates` MCP tool, both through SystemUpdateService.
  autoUpdates: z.boolean().optional(),
});

export type FileOnlySettings = z.infer<typeof fileOnlySettingsSchema>;

/**
 * Every key settings.json can hold.
 *
 * Keys it does not declare are stripped on read, and so dropped by the next write. That is
 * deliberate for a key a build retires, such as the MCP credentials SEC-MCP-8 moved into the hashed
 * key store: a stale credential must stop being carried forward. It also means a key the Hub writes
 * has to be declared here before anything writes it; `settings-round-trip.test.ts` fails otherwise.
 */
export const settingsFileSchema = settingsSchema.extend(fileOnlySettingsSchema.shape);

const partialSettingsSchema = settingsFileSchema.partial();

/** settings.json as it is persisted: every field optional, unknown keys stripped. */
export type PersistedSettings = z.infer<typeof partialSettingsSchema>;

export interface PersistedSettingsParseResult {
  settings: PersistedSettings;
  /** Fields that were present but unusable and have been dropped. Field names only, never values. */
  invalidKeys: string[];
  /** The file's top level was not a JSON object, so no field could be read at all. */
  unreadable: boolean;
}

/**
 * Reads persisted settings.json field by field, dropping only the entries that fail validation.
 *
 * settings.json is read twice on the way up: by `generateSystemEnvFile` before Nest exists, and by
 * `ConfigurationService`, which lifts `ciHubApiKey` and every inference preference out of it. An
 * all-or-nothing parse turns one unusable field — a hand edit, or a value written by a newer build
 * whose bounds this one rejects — into either an aborted boot or a Hub that silently forgets its
 * Portal credential and its inference preferences. Neither is recoverable from the UI, because the
 * UI needs the backend that just refused to come up.
 *
 * Parsing the fields one at a time is equivalent to one whole-object parse wherever the
 * whole-object parse would have succeeded: `settingsFileSchema` is a plain object with no object-level
 * refinement, so no field's validity depends on another's.
 */
export function parsePersistedSettings(raw: unknown): PersistedSettingsParseResult {
  const whole = partialSettingsSchema.safeParse(raw);
  if (whole.success) {
    return { settings: whole.data, invalidKeys: [], unreadable: false };
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings: {}, invalidKeys: [], unreadable: true };
  }

  const source = raw as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  const invalidKeys: string[] = [];

  for (const [key, fieldSchema] of Object.entries(partialSettingsSchema.shape)) {
    if (!(key in source)) continue;
    const field = (fieldSchema as z.ZodType).safeParse(source[key]);
    if (!field.success) {
      invalidKeys.push(key);
      continue;
    }
    // An optional field that parsed to undefined carries no value; leave the key absent so the
    // result is shaped exactly like a successful whole-object parse.
    if (field.data !== undefined) {
      settings[key] = field.data;
    }
  }

  return { settings: settings as PersistedSettings, invalidKeys, unreadable: false };
}

const simpleAppInfoSchema = appInfoObjectSchema.pick({
  id: true,
  urn: true,
  name: true,
  short_desc: true,
  categories: true,
  deprecated: true,
  created_at: true,
  supported_architectures: true,
  available: true,
});

const versionSchema = z.object({
  current: z.string(),
  latest: z.string(),
  body: z.string(),
  releases: z.array(z.object({ version: z.string(), body: z.string() })),
});

const appContextSchema = z.object({
  version: versionSchema,
  userSettings: settingsSchema,
  // Absolute host path of the root app-data folder (parent of every app's data).
  // Used by the Settings "Open app data folder" button; null when unresolved.
  appDataRootHostPath: z.string().nullable().optional(),
  // Host CPU architecture apps are installed against (from ARCHITECTURE / host probe).
  architecture: z.enum(['amd64', 'arm64']),
  user: userSchema,
  apps: z.array(simpleAppInfoSchema),
  updatesAvailable: z.number(),
  isProduction: z.boolean(),
  cloudflareAvailable: z.boolean(),
  tailscaleAvailable: z.boolean(),
  tailscaleNodeFqdn: z.string().trim().nullable().optional(),
  tailscaleSupportsServices: z.boolean().optional(),
  tailscaleHttpsEnabled: z.boolean().optional(),
});

// timeZone and the two Hub Pool knobs are validated here, on the WRITE path only — deliberately not
// on `settingsSchema` itself. That base schema also parses settings.json at boot
// (generateSystemEnvFile), where an invalid persisted value must degrade gracefully — to the host
// zone, or to the DEFAULT_POOL_* constant — rather than fail the parse and take down boot.
// Rejecting them here means a bad value gets a 400 at the moment it is chosen instead of being
// persisted and silently overridden on every subsequent boot.
// `autoUpdates` has its own endpoint (POST /system/update/auto-updates); this body does not take it.
const writableSettingsSchema = settingsSchema.omit({ autoUpdates: true });
export class UserSettingsBody extends createZodDto(
  writableSettingsSchema.partial().extend({
    timeZone: z
      .string()
      .trim()
      .refine((zone) => canonicalTimeZone(zone) !== undefined, { message: 'Must be a valid IANA time zone (e.g. Europe/Berlin)' })
      // Persist ICU's canonical form ('america/new_york' → 'America/New_York'), so settings.json
      // never holds a case-variant that the boot path would have to repair on every start.
      .transform((zone) => canonicalTimeZone(zone) as string)
      .optional(),
    hubPoolLocalAffinity: poolLocalAffinitySchema.optional(),
    hubPoolHealthPollSeconds: poolHealthPollSecondsSchema.optional(),
    hubPoolPressureWeight: poolPressureWeightSchema.optional(),
    hubPoolMaxPromptTokens: poolMaxPromptTokensSchema.optional(),
    hubPoolProbeSnapshotTtlMs: poolProbeSnapshotTtlMsSchema.optional(),
    inferenceSupervisionPollSeconds: inferenceSupervisionPollSecondsSchema.optional(),
    hubPoolPins: poolPinsSchema.optional(),
  }),
) {}

export type { z as ZodType } from 'zod';

export class AppContextDto extends createZodDto(appContextSchema) {}

const userContextDto = z.object({
  version: z.object({
    current: z.string(),
    latest: z.string(),
    body: z.string(),
    releases: z.array(z.object({ version: z.string(), body: z.string() })),
  }),
  isLoggedIn: z.boolean(),
  isConfigured: z.boolean(),
  isGuestDashboardEnabled: z.boolean(),
  isPasswordResetDisabled: z.boolean(),
  allowAutoThemes: z.boolean(),
  allowErrorMonitoring: z.boolean(),
  themeColor: z.string(),
  themeBase: z.string(),
  localDomain: z.string(),
  domain: z.string(),
  sslPort: z.number(),
  sessionExpiresAt: z.number().optional(),
  sessionRefreshRecommendedAt: z.number().optional(),
});

export class UserContextDto extends createZodDto(userContextDto) {}

export class AcknowledgeWelcomeBody extends createZodDto(z.object({ allowErrorMonitoring: z.boolean() })) {}
