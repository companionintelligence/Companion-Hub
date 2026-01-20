import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../packages/backend/src/core/database/drizzle/schema';
import { emptyDir } from './settings';

const port = process.env.POSTGRES_PORT || 6543;
const password = process.env.POSTGRES_PASSWORD || 'postgres';
const connectionString = `postgresql://tipi:${password}@${process.env.SERVER_IP}:${port}/tipi?connect_timeout=300`;

export const db = drizzle(connectionString, { schema });

export const clearDatabase = async () => {
  await emptyDir('./backups');
  await emptyDir('./user-config');
  await emptyDir('./state');

  // delete all data in table user
  await db.delete(schema.link);
  await db.delete(schema.user);
  await db.delete(schema.app);
  await db.delete(schema.deviceRegistration);
};

export const seedOrganization = async () => {
  try {
    await db.insert(schema.deviceRegistration).values({
      id: 'test-org-id',
      name: 'test-org',
      tunnelId: null,
      domain: 'test-org.example.com',
    });
  } catch (error) {
    console.error('Failed to seed organization:', error);
    throw error;
  }
};
