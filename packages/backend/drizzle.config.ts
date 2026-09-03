import { defineConfig } from 'drizzle-kit';

const user = process.env.POSTGRES_USERNAME || 'companion';
const password = process.env.POSTGRES_PASSWORD || 'postgres';
const dbName = process.env.POSTGRES_DBNAME || 'companiondb';
const port = process.env.POSTGRES_PORT || '6543';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/core/database/drizzle/schema.ts',
  out: './src/core/database/drizzle',
  dbCredentials: {
    url: `postgresql://${user}:${password}@localhost:${port}/${dbName}?connect_timeout=300`,
  },
});
