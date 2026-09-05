import { Client } from 'pg';

const database = process.env.POSTGRES_DBNAME || 'companion_ftue_e2e';

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
  throw new Error(`Unsafe PostgreSQL database name: ${database}`);
}

const client = new Client({
  database: process.env.POSTGRES_ADMIN_DB || 'postgres',
  host: process.env.POSTGRES_HOST || 'localhost',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  port: Number.parseInt(process.env.POSTGRES_PORT || '6543', 10),
  user: process.env.POSTGRES_USERNAME || 'companion',
});

async function main() {
  await client.connect();
  try {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (result.rowCount === 0) {
      await client.query(`CREATE DATABASE "${database}"`);
      process.stdout.write(`[future-onboarding] Created isolated PostgreSQL database ${database}.\n`);
    } else {
      process.stdout.write(`[future-onboarding] Reusing PostgreSQL database ${database}.\n`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
