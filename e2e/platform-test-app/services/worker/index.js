const { Client } = require('pg');

const config = {
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'e2e',
  password: process.env.DB_PASSWORD || 'e2e',
  database: process.env.DB_NAME || 'e2e',
};

async function run() {
  // Wait for Postgres to be ready
  let client;
  for (let i = 0; i < 30; i++) {
    try {
      client = new Client(config);
      await client.connect();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!client) {
    console.error('Failed to connect to Postgres');
    process.exit(1);
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  setInterval(async () => {
    try {
      await client.query('INSERT INTO worker_heartbeats DEFAULT VALUES');
      // Prune old rows to prevent unbounded growth
      await client.query("DELETE FROM worker_heartbeats WHERE created_at < NOW() - INTERVAL '5 minutes'");
    } catch (err) {
      console.error('Heartbeat error:', err.message);
    }
  }, 5000);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
