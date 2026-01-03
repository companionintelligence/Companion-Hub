import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import * as schema from '../../core/database/drizzle/schema';

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

const getClient = () => {
  return new Client({
    user: 'postgres',
    host: 'localhost',
    database: 'postgres',
    password: 'postgres',
    port: Number(process.env.POSTGRES_PORT) || 5433,
  });
};

export const createTestDatabase = async (testsuite: string) => {
  const client = getClient();
  await client.connect();

  await client.query(`DROP DATABASE IF EXISTS ${testsuite}`);
  await client.query(`CREATE DATABASE ${testsuite}`);

  await client.end();

  const connectionString = `postgresql://postgres:postgres@localhost:${Number(process.env.POSTGRES_PORT) || 5433}/${testsuite}?connect_timeout=300`;
  const drizzleClient = drizzle(connectionString, { schema });

  await migrate(drizzleClient, { migrationsFolder: path.join(__dirname, '..', '..', 'core', 'database', 'drizzle') }).catch((e) => {
    console.error('Failed to run migrations', e);
  });

  return drizzleClient;
};

export const dropTestDatabase = async (testsuite: string) => {
  const client = getClient();
  await client.connect();

  await client.query(`DROP DATABASE IF EXISTS ${testsuite}`);

  await client.end();
};

export const cleanTestData = async (db: TestDatabase) => {
  await db.delete(schema.link);
  await db.delete(schema.app);
  await db.delete(schema.user);
  await db.delete(schema.appStore);
};
