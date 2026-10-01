import { z } from 'zod';

export type Topic = 'app' | 'app-logs' | 'ci-hub-logs';

const appUrnSchema = z.string().refine((v) => v.split(':').length === 2);

const appStatusSchema = z.enum([
  'running',
  'stopped',
  'starting',
  'stopping',
  'updating',
  'missing',
  'installing',
  'install_failed',
  'uninstalling',
  'resetting',
  'restarting',
  'backing_up',
  'restoring',
  'uninstalled',
]);

const installQueueEntrySchema = z.object({
  urn: z.string(),
  name: z.string(),
});

const installQueueEventSchema = z.object({
  event: z.literal('install_queue'),
  active: installQueueEntrySchema.nullable(),
  queued: z.array(installQueueEntrySchema),
});

const appScopedEventSchema = z.object({
  event: z.enum([
    'status_change',
    'install_success',
    'install_error',
    'install_cancelled',
    'uninstall_success',
    'uninstall_error',
    'reset_success',
    'reset_error',
    'update_success',
    'update_error',
    'start_success',
    'start_error',
    'stop_success',
    'stop_error',
    'restart_success',
    'restart_error',
    'generate_env_success',
    'generate_env_error',
    'backup_success',
    'backup_error',
    'restore_success',
    'restore_error',
    'public_dns_error',
    'tailscale_serve_error',
    // A custom hostname CI-Cloud wired for this app was bound or unbound. Carries
    // no status — the row's `pendingRestart` is what changed, so the client just
    // refetches the app.
    'custom_domain_changed',
    // CI-Cloud published the app on another domain than the one it asked for,
    // and the Hub moved the app there. `hostname` is where it is served now.
    'public_domain_changed',
  ]),
  appUrn: appUrnSchema,
  appStatus: appStatusSchema.optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  errorDetail: z.string().optional(),
  settingsPath: z.string().optional(),
  hostname: z.string().optional(),
  progress: z.number().min(0).max(99).optional(),
  // Identifier for a non-fatal caveat on an otherwise-successful op (e.g. uninstall
  // completed but a root-owned path could not be fully removed). The client maps it
  // to a warning toast — a discriminator like errorCode, not rendered as a raw key.
  warningCode: z.string().optional(),
  // Optional detail for the caveat (e.g. the host path of an uninstall remnant), so the
  // client can render an actionable message such as a manual cleanup command.
  warningDetail: z.string().optional(),
});

/**
 * First message on every `app` stream: the running Hub introduces itself.
 *
 * A stack update recreates the Hub container, so the browser's EventSource drops and
 * reconnects on its own; the reconnect that succeeds is the new Hub answering. Carrying
 * the version in that first message lets the client tell "the update landed" from "the
 * old container is still up", and lets a tab whose bundle predates the Hub reload once —
 * with no polling on either side.
 */
const hubHelloEventSchema = z.object({
  event: z.literal('hub_hello'),
  /** The install env file's `CI_HUB_VERSION`, which the pending-update flow compares. */
  version: z.string(),
  /**
   * The running image's build stamp, as `GET /api/hub/build` reports it. Image builds give it the
   * same value as the page bundle's version, so the stale-tab check compares this, not `version`,
   * which can name another release. Absent on an unstamped image.
   */
  buildVersion: z.string().optional(),
});

/**
 * tailscaled started or stopped refusing the Hub's Tailscale Serve changes. It concerns every
 * Private VPN app at once, so it names none: open pages read `GET /tailscale/status` again, which
 * says why and gives the command that ends it.
 */
const tailscaleServePermissionEventSchema = z.object({
  event: z.literal('tailscale_serve_permission'),
  denied: z.boolean(),
});

export const sseSchema = z.union([
  z.object({
    topic: z.literal('app'),
    data: z.union([hubHelloEventSchema, installQueueEventSchema, tailscaleServePermissionEventSchema, appScopedEventSchema]),
  }),
  z.object({
    topic: z.literal('app-logs'),
    data: z.object({
      event: z.union([z.literal('newLogs'), z.literal('stopLogs')]),
      appUrn: appUrnSchema,
      lines: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    topic: z.literal('ci-hub-logs'),
    data: z.object({
      event: z.union([z.literal('newLogs'), z.literal('stopLogs')]),
      lines: z.array(z.string()).optional(),
    }),
  }),
]);

export type SSE = z.infer<typeof sseSchema>;
