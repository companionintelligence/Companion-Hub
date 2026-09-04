import { relations } from 'drizzle-orm';
import { boolean, customType, index, integer, pgEnum, pgTable, primaryKey, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

export const appStatusEnum = pgEnum('app_status_enum', [
  'running',
  'stopped',
  'installing',
  'install_failed',
  'uninstalling',
  'stopping',
  'starting',
  'missing',
  'updating',
  'resetting',
  'restarting',
  'backing_up',
  'restoring',
]);
export const updateStatusEnum = pgEnum('update_status_enum', ['FAILED', 'SUCCESS']);

export const link = pgTable('link', {
  id: serial().primaryKey().notNull(),
  title: varchar({ length: 20 }).notNull(),
  url: varchar().notNull(),
  iconUrl: varchar('icon_url'),
  createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  userId: integer('user_id')
    .notNull()
    .references(() => user.id),
  description: varchar({ length: 50 }),
  isVisibleOnGuestDashboard: boolean('is_visible_on_guest_dashboard').default(false).notNull(),
});

const appConfig = customType<{ data: Record<string, unknown>; driverData: string }>({
  dataType() {
    return 'jsonb';
  },
  toDriver(value: Record<string, unknown>): string {
    return JSON.stringify(value);
  },
});

export const app = pgTable(
  'app',
  {
    id: serial().primaryKey().notNull(),
    status: appStatusEnum().default('stopped').notNull(),
    config: appConfig('config').notNull(),
    createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
    version: integer().default(1).notNull(),
    ignoredVersion: integer('ignored_version'),
    exposed: boolean().default(false).notNull(),
    domain: varchar(),
    isVisibleOnGuestDashboard: boolean('is_visible_on_guest_dashboard').default(false).notNull(),
    openPort: boolean('open_port').default(true).notNull(),
    port: integer(),
    exposedLocal: boolean('exposed_local').default(false).notNull(),
    exposureMode: varchar('exposure_mode').default('local').notNull(), // 'local' | 'cloudflare' | 'tailscale'
    appStoreSlug: varchar('app_store_slug').notNull(),
    appName: varchar('app_name').notNull(),
    enableAuth: boolean('enable_auth').default(false).notNull(),
    subnet: varchar().unique(),
    localSubdomain: varchar('local_subdomain'),
    publicDomain: varchar('public_domain'),
    /**
     * Customer-owned hostname Companion Portal has actually wired to this app's platform
     * hostname, mirrored from the `customDomains[]` of the last successful tunnel
     * sync. NOT user input: the Hub cannot tell whether a hostname is really
     * routed, so only a delivered binding may land here.
     *
     * `null` means "serve on the platform hostname" — the state an unbind
     * restores. Env generation reads this column, so a change here means the
     * app's compose env is stale until it is restarted (`pendingRestart`).
     */
    customDomain: varchar('custom_domain'),
    /**
     * The custom domain the person installing this app ASKED for — the choice,
     * not the outcome.
     *
     * Env generation never reads this. {@link customDomain} is what Companion Portal
     * confirmed it wired and is the only value an app may be told to emit; this
     * is user input, and the Hub cannot tell whether a hostname really resolves
     * to this tunnel. Emitting a public URL for one that does not is worse than
     * emitting the platform URL, because the app would sign OAuth redirects for
     * an address nothing answers on.
     *
     * It exists because the two cannot happen at the same moment: at install
     * time Companion Portal has never heard of the app, so there is nothing to bind a
     * domain to yet. The intent is recorded here, the tunnel sync registers the
     * app, the bind follows, and the delivered binding then lands in
     * `custom_domain` like any other. `null` means "serve on the platform
     * hostname", which is also what clearing the field asks for.
     */
    customDomainIntent: varchar('custom_domain_intent'),
    /**
     * The operator confirmed that satisfying {@link customDomainIntent} may take
     * the domain OFF whatever is serving it now.
     *
     * Only ever true alongside an intent, and cleared with it. It exists because
     * the bind pass runs long after the dialog is closed and cannot ask anyone
     * anything: CI-Cloud will happily retarget a domain that is live on a
     * sibling Hub in the organization, so without a recorded answer the pass has
     * to choose between silently moving a production hostname off another device
     * and never honouring a deliberate move at all. Neither is acceptable, so
     * the person choosing is asked once, in the dialog, and their answer is
     * carried here.
     *
     * ⚠ DEFAULTS FALSE, AND AN ABSENT ANSWER IS A NO. Every intent recorded
     * before this column existed, and every client that does not know about it,
     * reads as unconfirmed — which refuses the takeover and leaves the domain
     * where it is. The failure mode of guessing wrong in the other direction is
     * a customer's production hostname moving between devices unannounced.
     */
    customDomainTakeover: boolean('custom_domain_takeover').default(false).notNull(),
    pendingRestart: boolean('pending_restart').default(false).notNull(),
    userConfigEnabled: boolean('user_config_enabled').default(true).notNull(),
    maxBackups: integer('max_backups'),
  },
  (table) => [uniqueIndex('app_name_store_slug_uidx').on(table.appName, table.appStoreSlug)],
);

export const appRelations = relations(app, ({ one }) => ({
  appStore: one(appStore, {
    fields: [app.appStoreSlug],
    references: [appStore.slug],
  }),
}));

export const user = pgTable('user', {
  id: serial().primaryKey().notNull(),
  username: varchar().notNull(),
  password: varchar().notNull(),
  createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  operator: boolean().default(false).notNull(),
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').default(false).notNull(),
  salt: text(),
  locale: varchar().default('en').notNull(),
  hasCompletedOnboarding: boolean('has_completed_onboarding').default(false).notNull(),
  advancedMode: boolean('advanced_mode').default(false).notNull(),
});

/**
 * Binds a verified external OIDC identity — the (issuer, subject) pair from a
 * Portal / IdP token — to a local Hub `user`. This is the authoritative link
 * for federated login: the `sub` claim is stable and opaque, so it survives
 * email changes and prevents the email-reuse account-takeover gap that existed
 * when provisioning matched on email alone.
 *
 * See CI-Engineering architecture/identity/unified-identity-plan.md (Track B, B2).
 */
export const federatedIdentity = pgTable(
  'federated_identity',
  {
    id: serial().primaryKey().notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => user.id),
    /** OIDC `iss` claim — the token issuer (e.g. the Portal IdP base URL). */
    issuer: varchar().notNull(),
    /** OIDC `sub` claim — stable, opaque subject identifier at the issuer. */
    subject: varchar().notNull(),
    /** Value of the `email` claim at link time, kept for audit/display only (never used for auth matching). */
    email: varchar(),
    /** True when the identity was linked from a verified `email_verified` claim rather than legacy email fallback. */
    emailVerified: boolean('email_verified').default(false).notNull(),
    createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('federated_identity_issuer_subject_idx').on(table.issuer, table.subject)],
);

export const federatedIdentityRelations = relations(federatedIdentity, ({ one }) => ({
  user: one(user, {
    fields: [federatedIdentity.userId],
    references: [user.id],
  }),
}));

export const appStore = pgTable('app_store', {
  slug: varchar().notNull().primaryKey(),
  hash: varchar().notNull().unique(),
  name: varchar({ length: 16 }).notNull(),
  enabled: boolean().default(true).notNull(),
  url: varchar().notNull(),
  branch: varchar().default('main').notNull(),
  createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  type: text().default('git'),
});

export const portAllocation = pgTable(
  'port_allocation',
  {
    id: serial().primaryKey().notNull(),
    appUrn: varchar('app_urn').notNull(),
    hostPort: integer('host_port').notNull(),
    containerPort: integer('container_port').notNull(),
    protocol: varchar({ length: 3 }).default('tcp').notNull(), // 'tcp' | 'udp'
    label: varchar({ length: 64 }).default('main').notNull(), // e.g. 'main', 'admin-ui', 'api'
    createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('port_protocol_idx').on(table.hostPort, table.protocol)],
);

// SEC-MCP-8: locally-minted, hashed API keys. One table for ALL inbound key surfaces, discriminated
// by `scopes` ('mcp' tools, 'app' callbacks; 'rest' etc. later) so a new surface doesn't need a new
// table — and so one key can open several at once without holding several secrets. Only the
// SHA-256 hash is stored (never the raw key); the raw is shown once at creation. `managed` keys are
// auto-provisioned by the Hub for companion apps (Hermes, OpenClaw, any hub_integration.mcp_client
// app) and carry the owning app's URN — operators see them but never create/edit them by hand.
// NOTE: this is distinct from `ciHubApiKey` (the Portal-issued device credential in settings.json,
// stored plaintext because the Hub replays it outbound to CI-Portal) — that stays where it is.
export const apiKey = pgTable(
  'api_key',
  {
    id: serial().primaryKey().notNull(),
    // Which surfaces accept this key ('mcp' tools, 'app' callbacks). One key can open several, so
    // a companion app holds a single credential and scope grants never rotate its secret.
    scopes: text().array().default([]).notNull(),
    // What the key may DO on those surfaces: 'read' | 'write' | 'full' (see api-key.capabilities.ts).
    // A second, orthogonal axis to `scopes` — surface vs verb — replacing the appliance-wide
    // MCP_ALLOW_DESTRUCTIVE gate, which could only be on or off for every key at once.
    capability: varchar().default('write').notNull(),
    name: varchar().notNull(),
    prefix: varchar({ length: 12 }).notNull(), // leading chars of the raw key, for UI identification
    hashedKey: varchar('hashed_key').notNull(),
    managed: boolean().default(false).notNull(),
    ownerAppUrn: varchar('owner_app_urn'), // set for managed keys: the companion app that owns it
    expiresAt: timestamp('expires_at', { mode: 'string' }), // null = never expires
    lastUsedAt: timestamp('last_used_at', { mode: 'string' }),
    createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  },
  // Uniqueness follows the lookup: a key resolves by hash alone (scope membership is then checked on
  // the resolved row), so the hash must be globally unique — a second row sharing it would make
  // resolution ambiguous.
  (table) => [uniqueIndex('api_key_hashed_key_idx').on(table.hashedKey)],
);

export const deviceRegistration = pgTable('device_registration', {
  id: varchar().notNull().primaryKey(), // organization_id from Companion Portal
  slug: varchar().notNull(), // organization slug for subdomain
  name: varchar().notNull(), // organization label for display
  /**
   * The canonical hub subdomain prefix (e.g. "core1-xyz").
   * This is the authoritative source for the Hub's route identity in Cloudflare tunnel config.
   * Assigned by CI Portal during device registration and stored here — NOT derived from DOMAIN.
   * When null, the Hub route is excluded from Cloudflare sync.
   */
  hubSubdomain: varchar('hub_subdomain'),
  tunnelId: varchar('tunnel_id'), // Cloudflare Tunnel ID (nullable now)
  tunnelToken: varchar('tunnel_token'),
  /**
   * Explicit provisioning phase — replaces the implicit registered boolean.
   * See registration-state.ts for the full phase model.
   * Defaults to 'locally_ready' so existing rows remain operational after migration.
   */
  provisioningPhase: varchar('provisioning_phase').default('locally_ready').notNull(),
  /** JSON array of DegradedReason strings. Non-empty only when provisioningPhase = 'degraded'. */
  degradedReasons: text('degraded_reasons').default('[]').notNull(),
  createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

/**
 * Per-app Companion Memory connection state + the (encrypted) minted api key.
 *
 * One row per memory-consumer app (keyed by app URN). `state` drives the
 * interstitial ('unconfigured' | 'connected' | 'skipped' | 'manual'); the
 * transient 'deferred' choice lives in a wrapper cookie, not here. `encryptedKey`
 * holds the CI-Server-issued key (AES-256-GCM via EncryptionService, salt = URN)
 * — the Hub must retain the raw value because it re-emits it into the app's env
 * on every restart, and CI-Server only ever reveals it once.
 */
export const memoryConnection = pgTable('memory_connection', {
  id: serial().primaryKey().notNull(),
  appUrn: varchar('app_urn').notNull().unique(),
  state: varchar().default('unconfigured').notNull(), // 'unconfigured' | 'connected' | 'skipped' | 'manual'
  encryptedKey: text('encrypted_key'), // encrypted CI-Server api key; null unless connected
  serverUrl: varchar('server_url'), // resolved Companion Memory URL captured at connect time
  keyExpiresAt: timestamp('key_expires_at', { withTimezone: true, mode: 'string' }), // instant the CI-Server key expires (timestamptz preserves the UTC offset); null unless connected. Rotation refreshes it well before this.
  createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

const telemetryJson = customType<{ data: unknown; driverData: string }>({
  dataType() {
    return 'jsonb';
  },
  toDriver(value: unknown): string {
    return JSON.stringify(value);
  },
  fromDriver(value: unknown): unknown {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  },
});

/**
 * Rolling local snapshots of host + Docker capacity/load. Survives Hub API restarts
 * (Postgres is a separate volume) so the resources page and self-heal still have
 * history from before the process died.
 */
export const hostTelemetrySample = pgTable(
  'host_telemetry_sample',
  {
    id: serial().primaryKey().notNull(),
    sampledAt: timestamp('sampled_at', { mode: 'string' }).defaultNow().notNull(),
    cpuLoad: integer('cpu_load'),
    cpuCores: integer('cpu_cores'),
    memoryUsed: integer('memory_used'),
    memoryTotal: integer('memory_total'),
    diskUsed: integer('disk_used'),
    diskTotal: integer('disk_total'),
    percentUsedMemory: integer('percent_used_memory'),
    dockerAvailable: boolean('docker_available'),
    dockerInfo: telemetryJson('docker_info'),
    apps: telemetryJson('apps'),
    source: varchar().default('collector').notNull(),
  },
  (table) => [index('host_telemetry_sample_sampled_at_idx').on(table.sampledAt)],
);

/** Structured local events (API start/stop, docker flips, degraded apps) for post-mortem. */
export const hostEventLog = pgTable(
  'host_event_log',
  {
    id: serial().primaryKey().notNull(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    level: varchar().notNull(),
    source: varchar().notNull(),
    message: text().notNull(),
    details: telemetryJson('details'),
  },
  (table) => [index('host_event_log_created_at_idx').on(table.createdAt)],
);

/**
 * Hub-side cache of Portal marketplace app entitlement checks.
 *
 * Portal is the till. This table is UX only — a modified Hub can skip it.
 * TTL and start-grace live in MarketplaceEntitlementService, not here.
 */
export const entitlementCache = pgTable('entitlement_cache', {
  appUrn: varchar('app_urn').primaryKey().notNull(),
  entitled: boolean().notNull(),
  reason: varchar(),
  paymentUrl: varchar('payment_url'),
  cachedAt: timestamp('cached_at', { mode: 'string' }).defaultNow().notNull(),
});

/**
 * Hub UX cache of Portal WhoIs CapMaps. Not a till. Keyed by Portal user
 * id (`federated_identity.subject`) and catalog slug. `version` is the
 * org ACL version so a PUT on Portal drops stale `can[]`.
 */
export const whoisCache = pgTable(
  'whois_cache',
  {
    subject: varchar().notNull(),
    appId: varchar('app_id').notNull(),
    canJson: text('can_json').notNull(),
    version: integer().notNull(),
    cachedAt: timestamp('cached_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.subject, table.appId] })],
);
