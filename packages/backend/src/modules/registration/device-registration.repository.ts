import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@/core/database/database.service';
import { deviceRegistration } from '@/core/database/drizzle/schema';
import { eq, type InferInsertModel } from 'drizzle-orm';

@Injectable()
export class DeviceRegistrationRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async getDeviceRegistrationById(orgId: string) {
    const result = await this.databaseService.db.select().from(deviceRegistration).where(eq(deviceRegistration.id, orgId)).limit(1);

    return result[0] || null;
  }

  async createDeviceRegistration(data: { id: string; slug: string; name: string; tunnelId: string | null; tunnelToken?: string | null }) {
    const result = await this.databaseService.db.insert(deviceRegistration).values(data).returning();

    return result[0];
  }

  async updateDeviceRegistration(orgId: string, data: Partial<InferInsertModel<typeof deviceRegistration>>) {
    const result = await this.databaseService.db
      .update(deviceRegistration)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(deviceRegistration.id, orgId))
      .returning();

    return result[0] || null;
  }

  async hasAnyDeviceRegistration(): Promise<boolean> {
    const result = await this.databaseService.db.select().from(deviceRegistration).limit(1);

    return result.length > 0;
  }

  async getFirstDeviceRegistration() {
    const result = await this.databaseService.db.select().from(deviceRegistration).limit(1);

    return result[0] || null;
  }

  async deleteDeviceRegistration(orgId: string) {
    await this.databaseService.db.delete(deviceRegistration).where(eq(deviceRegistration.id, orgId));
  }
}
