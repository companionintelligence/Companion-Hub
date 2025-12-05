import { relations } from 'drizzle-orm';
import { boolean, customType, integer, numeric, pgEnum, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';

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
});

// Payment-related enums
export const paymentStatusEnum = pgEnum('payment_status_enum', ['pending', 'completed', 'failed', 'refunded']);
export const paymentMethodEnum = pgEnum('payment_method_enum', ['stripe', 'x402']);
export const subscriptionStatusEnum = pgEnum('subscription_status_enum', ['active', 'cancelled', 'expired']);
export const subscriptionIntervalEnum = pgEnum('subscription_interval_enum', ['monthly', 'yearly']);

// Payment table - tracks individual payments
export const payment = pgTable('payment', {
  id: serial().primaryKey().notNull(),
  appUrn: varchar('app_urn').notNull(),
  userId: integer('user_id')
    .notNull()
    .references(() => user.id),
  paymentMethod: paymentMethodEnum('payment_method').notNull(),
  amount: numeric({ precision: 10, scale: 2 }).notNull(),
  currency: varchar({ length: 3 }).default('USD').notNull(),
  status: paymentStatusEnum().default('pending').notNull(),
  stripePaymentIntentId: varchar('stripe_payment_intent_id'),
  x402TransactionHash: varchar('x402_transaction_hash'),
  createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const paymentRelations = relations(payment, ({ one }) => ({
  user: one(user, {
    fields: [payment.userId],
    references: [user.id],
  }),
}));

// Subscription table - tracks recurring subscriptions
export const subscription = pgTable('subscription', {
  id: serial().primaryKey().notNull(),
  appUrn: varchar('app_urn').notNull(),
  userId: integer('user_id')
    .notNull()
    .references(() => user.id),
  paymentMethod: paymentMethodEnum('payment_method').notNull(),
  amount: numeric({ precision: 10, scale: 2 }).notNull(),
  currency: varchar({ length: 3 }).default('USD').notNull(),
  interval: subscriptionIntervalEnum().notNull(),
  status: subscriptionStatusEnum().default('active').notNull(),
  stripeSubscriptionId: varchar('stripe_subscription_id'),
  currentPeriodStart: timestamp('current_period_start', { mode: 'string' }),
  currentPeriodEnd: timestamp('current_period_end', { mode: 'string' }),
  cancelledAt: timestamp('cancelled_at', { mode: 'string' }),
  createdAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
  updatedAt: timestamp({ mode: 'string' }).defaultNow().notNull(),
});

export const subscriptionRelations = relations(subscription, ({ one }) => ({
  user: one(user, {
    fields: [subscription.userId],
    references: [user.id],
  }),
}));
