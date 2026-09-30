import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../packages/backend/src/core/database/drizzle/schema';
import { emptyDir } from './settings';

const port = process.env.POSTGRES_PORT || 6543;
const password = process.env.POSTGRES_PASSWORD || 'postgres';
const username = process.env.POSTGRES_USERNAME || 'companion';
const dbName = process.env.POSTGRES_DBNAME || 'companiondb';
const host = process.env.SERVER_IP || process.env.POSTGRES_HOST || 'localhost';
const connectionString = `postgresql://${username}:${password}@${host}:${port}/${dbName}?connect_timeout=300`;

export const db = drizzle(connectionString, { schema });

export const clearDatabase = async () => {
  await emptyDir('./backups');
  await emptyDir('./user-config');
  await emptyDir('./state');

  /*
   * Children before parents. This list is hand-maintained, so a new table with a
   * non-cascading FK to one of these breaks every test at fixture setup, not in the
   * test body — the `page` fixture calls this before each test.
   *
   * `federated_identity.user_id` references `user.id` with no `onDelete`
   * (schema.ts:183), so it MUST be deleted first. `api_key.created_by_user_id`
   * cascades (schema.ts:261) and needs no entry. When you add a table that points
   * at one of these, add it here above its parent.
   */
  await db.delete(schema.link);
  await db.delete(schema.federatedIdentity);
  await db.delete(schema.user);
  await db.delete(schema.app);
  await db.delete(schema.appStore);
  await db.delete(schema.deviceRegistration);
};

export const deleteAppByName = async (appName: string) => {
  await db.delete(schema.app).where(eq(schema.app.appName, appName));
};

export const seedOrganization = async () => {
  try {
    await db.insert(schema.deviceRegistration).values({
      id: 'test-org-id',
      name: 'test-org',
      slug: 'test-org',
      tunnelId: null,
      provisioningPhase: 'locally_ready',
      domain: 'test-org.example.com',
    });
  } catch (error) {
    console.error('Failed to seed organization:', error);
    throw error;
  }
};
