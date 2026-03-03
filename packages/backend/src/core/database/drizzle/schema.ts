import { relations } from 'drizzle-orm';
import { boolean, customType, integer, pgEnum, pgTable, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

export const appStatusEnum = pgEnum('app_status_enum', [
  'running',
  'stopped',
  'installing',
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
  hasSeenWelcome: boolean('has_seen_welcome').default(false).notNull(),
  hasCompletedOnboarding: boolean('has_completed_onboarding').default(false).notNull(),
  advancedMode: boolean('advanced_mode').default(false).notNull(),
});

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
  tunnelId: varchar('tunnel_id'), // Cloudflare Tunnel ID (nullable now)
  tunnelToken: varchar('tunnel_token'),
  createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});
