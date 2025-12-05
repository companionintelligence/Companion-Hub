import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATABASE_PATH = process.env.DATABASE_PATH || './data/payments.db';

let db: Database.Database;

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

export function initializeDatabase(): void {
  // Ensure data directory exists
  const dbDir = path.dirname(DATABASE_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log('Created database directory:', dbDir);
  }
  
  db = new Database(DATABASE_PATH);
  
  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');
  
  // Create tables
  db.exec(`
    -- Users/Accounts table (source of truth for payment service)
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      username TEXT UNIQUE,
      display_name TEXT,
      avatar_url TEXT,
      email_verified INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- OAuth clients (registered applications that can use this OAuth server)
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL, -- JSON array of allowed redirect URIs
      scopes TEXT NOT NULL DEFAULT '["read","write"]', -- JSON array of allowed scopes
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- OAuth authorization codes (short-lived, used in authorization code flow)
    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      redirect_uri TEXT NOT NULL,
      scopes TEXT NOT NULL, -- JSON array
      code_challenge TEXT, -- For PKCE
      code_challenge_method TEXT, -- 'S256' or 'plain'
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES oauth_clients(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- OAuth access tokens
    CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      token TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      scopes TEXT NOT NULL, -- JSON array
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES oauth_clients(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- OAuth refresh tokens
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      client_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      revoked INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES oauth_clients(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- User sessions (for web UI login)
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Payments table
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_urn TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('stripe', 'x402')),
      amount TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed', 'refunded')),
      stripe_payment_intent_id TEXT,
      x402_transaction_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- Subscriptions table
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_urn TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('stripe', 'x402')),
      amount TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      interval TEXT NOT NULL CHECK(interval IN ('monthly', 'yearly')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'cancelled', 'expired')),
      stripe_subscription_id TEXT,
      current_period_start TEXT,
      current_period_end TEXT,
      cancelled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- App entitlements (tracks what apps a user has access to)
    CREATE TABLE IF NOT EXISTS app_entitlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      app_urn TEXT NOT NULL,
      entitlement_type TEXT NOT NULL CHECK(entitlement_type IN ('purchase', 'subscription', 'free')),
      payment_id INTEGER,
      subscription_id INTEGER,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT, -- NULL for lifetime access
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (payment_id) REFERENCES payments(id),
      FOREIGN KEY (subscription_id) REFERENCES subscriptions(id),
      UNIQUE(user_id, app_urn)
    );

    -- Create indexes for faster lookups
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_codes_client ON oauth_authorization_codes(client_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_codes_user ON oauth_authorization_codes(user_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_access_tokens(client_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_access_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client ON oauth_refresh_tokens(client_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_app ON payments(app_urn);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_app ON subscriptions(app_urn);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
    CREATE INDEX IF NOT EXISTS idx_entitlements_user ON app_entitlements(user_id);
    CREATE INDEX IF NOT EXISTS idx_entitlements_app ON app_entitlements(app_urn);
  `);

  console.log('SQLite database initialized at:', DATABASE_PATH);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
  }
}
