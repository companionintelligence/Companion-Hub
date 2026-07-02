import { relations } from 'drizzle-orm';
import { boolean, customType, integer, pgEnum, pgTable, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

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

export const app = pgTable('app', {
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
  pendingRestart: boolean('pending_restart').default(false).notNull(),
  userConfigEnabled: boolean('user_config_enabled').default(true).notNull(),
  maxBackups: integer('max_backups'),
});

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

export const deviceRegistration = pgTable('device_registration', {
  id: varchar().notNull().primaryKey(), // organization_id from CI Cloud
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
