import { DATABASE, type Database } from '@/core/database/database.module';
import { deviceRegistration } from '@/core/database/drizzle/schema';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

@Injectable()
export class RegistrationRepository {
  constructor(@Inject(DATABASE) private db: Database) {}

  public async getRegistration() {
    return this.db.query.deviceRegistration.findFirst();
  }

  public async createRegistration(data: typeof deviceRegistration.$inferInsert) {
    return this.db.insert(deviceRegistration).values(data).returning().execute();
  }

  public async updateRegistration(id: number, data: Partial<typeof deviceRegistration.$inferInsert>) {
    return this.db
      .update(deviceRegistration)
      .set(data)
      .where(eq(deviceRegistration.id, id))
      .returning()
      .execute();
  }

  public async deleteRegistration(id: number) {
    return this.db.delete(deviceRegistration).where(eq(deviceRegistration.id, id)).execute();
  }
}
