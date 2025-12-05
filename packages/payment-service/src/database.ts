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
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Create indexes for faster lookups
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_app ON payments(app_urn);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_app ON subscriptions(app_urn);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
  `);

  console.log('SQLite database initialized at:', DATABASE_PATH);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
  }
}
