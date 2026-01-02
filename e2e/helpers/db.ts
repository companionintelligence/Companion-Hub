import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../packages/backend/src/core/database/drizzle/schema';
import { emptyDir } from './settings';

const port = process.env.POSTGRES_PORT || 6543;
const connectionString = `postgresql://tipi:${process.env.POSTGRES_PASSWORD}@${process.env.SERVER_IP}:${port}/tipi?connect_timeout=300`;

export const db = drizzle(connectionString, { schema });

export const clearDatabase = async () => {
  await emptyDir('./backups');
  await emptyDir('./user-config');

  // delete all data in table user
  await db.delete(schema.link);
  await db.delete(schema.user);
  await db.delete(schema.app);
  await db.delete(schema.organization);
};

export const seedOrganization = async () => {
  try {
    await db.insert(schema.organization).values({
      id: 'test-org-id',
      name: 'test-org',
      tunnelId: 'test-tunnel-id',
      domain: 'test-org.companionintel.com',
    });
  } catch (error) {
    console.error('Failed to seed organization:', error);
    throw error;
  }
};
