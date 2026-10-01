import { APP_STATUS } from '@/core/database/drizzle/types';
import { MetadataDto } from '@/modules/marketplace/dto/marketplace.dto';
import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';
import { appInfoSchema } from '@ci-hub/common/schemas';

const metadataSchema = (MetadataDto as unknown as { schema: z.ZodType }).schema;
const appInfoSchemaRef = appInfoSchema;

const appSchema = z.object({
  id: z.number(),
  port: z.number().nullable(),
  status: z.enum(APP_STATUS),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  version: z.number(),
  exposed: z.boolean(),
  openPort: z.boolean(),
  exposedLocal: z.boolean(),
  domain: z.string().nullable(),
  isVisibleOnGuestDashboard: z.boolean(),
  config: z.record(z.string(), z.unknown()).optional(),
  enableAuth: z.boolean().optional(),
  /** Seeds the settings dialog from the ROW, the same way `customDomainTakeover` is. */
  autoRestartOnDomainChange: z.boolean().optional(),
  localSubdomain: z.string().nullable().optional(),
  exposureMode: z.enum(['local', 'cloudflare', 'tailscale']).optional(),
  publicDomain: z.string().nullable().optional(),
  /** Custom hostname Companion Portal has wired for this app; null when it serves on the platform hostname. */
  customDomain: z.string().nullable().optional(),
  /**
   * The custom domain this app was set up to use — the CHOICE, not the outcome.
   *
   * Exposed so the settings dialog can seed its picker from the row rather than
   * from the stored form snapshot: the Hub clears the choice when the domain
   * stops being connected, or when it is chosen for another app, and a snapshot
   * that still names it would silently re-claim it on the next save.
   */
  customDomainIntent: z.string().nullable().optional(),
  /**
   * Whether the operator has confirmed that {@link customDomainIntent} may be
   * taken off whatever is serving it now — and has not had that answer spent
   * yet.
   *
   * Exposed for the same reason the intent is, and it must come from the ROW
   * rather than the stored form snapshot: the bind pass clears it the moment it
   * acts on it, so the row is the only place that knows whether a confirmation
   * is still outstanding. Seeding a still-pending move from here keeps an
   * unrelated save from quietly withdrawing it.
   */
  customDomainTakeover: z.boolean().optional(),
  pendingRestart: z.boolean(),
  ignoredVersion: z.number().nullable(),
});

const myAppsSchema = z.object({
  installed: z.array(
    z.object({
      app: appSchema,
      info: appInfoSchemaRef,
      metadata: metadataSchema,
    }),
  ),
});

/**
 * The guest dashboard is served WITHOUT `AuthGuard` (`apps.controller.ts`,
 * `GET /apps/guest`), so its payload is the set of app facts anyone on the
 * network may read.
 *
 * The choice is not one of them. `custom_domain` is a hostname Companion Portal has
 * already WIRED — live and publicly resolvable, so naming it discloses nothing.
 * `custom_domain_intent` can name a domain the organization owns but has not
 * published: parked, or still verifying, and not discoverable any other way.
 * `custom_domain_takeover` goes with it for the same reason and one of its own —
 * on its own it discloses that this organization has an outstanding, unconfirmed
 * plan to move a domain off something, which is a fact about their intentions
 * rather than about an address anyone can already resolve.
 * `reportOnly` parsing strips whatever the schema omits, so leaving it out here
 * is what keeps it out of the response.
 *
 * `config` is the form the operator filled in at install — admin passwords, provider API
 * keys, whatever a manifest asked for — and this route is unauthenticated, so it is the
 * first thing omitted. The guest dashboard renders tiles and links; it has no use for it.
 *
 * What this schema keeps is exactly what a guest tile is built from.
 */
const guestAppSchema = appSchema.omit({ config: true, customDomainIntent: true, customDomainTakeover: true });

const GUEST_APP_FIELDS = Object.keys(guestAppSchema.shape) as ReadonlyArray<keyof typeof guestAppSchema.shape>;

/**
 * Keep of one app row only the fields a guest tile uses.
 *
 * ⚠ THIS IS THE ENFORCEMENT; THE SCHEMA BELOW ONLY DESCRIBES IT. `Dto.parse(data, { reportOnly })`
 * returns the PARSED data when validation passes but the RAW INPUT when it fails, so a field
 * "stripped by omission" is only stripped while every other field of every row happens to validate.
 * One drifted column and the response goes out with whatever the row holds. The row holds more than
 * the schema lists: the repository loads it `with: { appStore: true }`, and a store's `url` can carry
 * a token (`https://ghp_…@github.com/…`). So the route allows by name, from the schema's own shape,
 * before the parse; a new column is private until it is added to the schema on purpose.
 */
export function pickGuestAppFields<T extends object>(app: T): Pick<T, Extract<keyof T, (typeof GUEST_APP_FIELDS)[number]>> {
  const row = app as Record<string, unknown>;
  const visible: Record<string, unknown> = {};

  for (const field of GUEST_APP_FIELDS) {
    if (field in row) {
      visible[field] = row[field];
    }
  }

  return visible as Pick<T, Extract<keyof T, (typeof GUEST_APP_FIELDS)[number]>>;
}

const guestAppsSchema = z.object({
  installed: z.array(
    z.object({
      app: guestAppSchema,
      info: appInfoSchemaRef,
      metadata: metadataSchema,
    }),
  ),
});

const getAppSchema = z.object({
  app: appSchema.nullable().optional(),
  info: appInfoSchemaRef,
  metadata: metadataSchema,
  appDataHostPath: z.string().nullable().optional(),
  mcpInstallSchema: z
    .object({
      transport: z.enum(['stdio', 'http']).optional(),
      requires: z.record(z.string(), z.unknown()).optional(),
      tags: z.array(z.string()),
      fields: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          hint: z.string().optional(),
          required: z.boolean(),
          secret: z.boolean(),
          default: z.union([z.string(), z.number(), z.boolean()]).optional(),
          source: z.enum(['form_field', 'mcp_env']),
        }),
      ),
      toolCount: z.number(),
      bridgeable: z.boolean(),
      bridgeWarning: z.string().optional(),
    })
    .nullable()
    .optional(),
  mcpRuntime: z
    .object({
      bridgeable: z.boolean(),
      transport: z.string().optional(),
      containerStatus: z.enum(['running', 'stopped', 'missing', 'unknown']),
      toolCount: z.number(),
      lastError: z.string().optional(),
      lastProbeAt: z.string().optional(),
      bridgeWarning: z.string().optional(),
      connected: z.boolean(),
    })
    .nullable()
    .optional(),
});

const getRandomPortSchema = z.object({
  port: z.number(),
});

const getComposeDiff = z.object({
  current: z.string().nullable(),
  new: z.string().nullable(),
});

const getConfigDiffSchema = z.object({
  current: z.string().nullable(),
  new: z.string().nullable(),
});

const appDataListingSchema = z.object({
  hostPath: z.string().nullable(),
  rootExists: z.boolean(),
  truncated: z.boolean(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      kind: z.enum(['file', 'directory']),
      sizeBytes: z.number().nullable(),
    }),
  ),
});

const installedAppUrnsSchema = z.object({
  urns: z.array(z.string()),
});

const updatesAvailableSchema = z.object({
  updatesAvailable: z.number(),
});

export class MyAppsDto extends createZodDto(myAppsSchema) {}
export class GuestAppsDto extends createZodDto(guestAppsSchema) {}
export class InstalledAppUrnsDto extends createZodDto(installedAppUrnsSchema) {}
export class UpdatesAvailableDto extends createZodDto(updatesAvailableSchema) {}
export class GetAppDto extends createZodDto(getAppSchema) {}
export class GetRandomPortDto extends createZodDto(getRandomPortSchema) {}
export class GetConfigDiffDto extends createZodDto(getConfigDiffSchema) {}
export class GetComposeDiffDto extends createZodDto(getComposeDiff) {}
export class AppDataListingDto extends createZodDto(appDataListingSchema) {}
