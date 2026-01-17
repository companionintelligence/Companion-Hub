import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@/core/database/database.service';
import { deviceRegistration } from '@/core/database/drizzle/schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class DeviceRegistrationRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async getOrganizationById(orgId: string) {
    const result = await this.databaseService.db.select().from(deviceRegistration).where(eq(deviceRegistration.id, orgId)).limit(1);

    return result[0] || null;
  }

  async createOrganization(data: { id: string; name: string; tunnelId: string | null; tunnelToken?: string | null; domain: string }) {
    const result = await this.databaseService.db.insert(deviceRegistration).values(data).returning();

    return result[0];
  }

  async updateOrganization(
    orgId: string,
    data: Partial<{
      name: string;
      tunnelId: string;
      tunnelToken: string;
      domain: string;
    }>,
  ) {
    const result = await this.databaseService.db
      .update(deviceRegistration)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(deviceRegistration.id, orgId))
      .returning();

    return result[0] || null;
  }

  async hasAnyOrganization(): Promise<boolean> {
    const result = await this.databaseService.db.select().from(deviceRegistration).limit(1);

    return result.length > 0;
  }

  async getFirstOrganization() {
    const result = await this.databaseService.db.select().from(deviceRegistration).limit(1);

    return result[0] || null;
  }

  async deleteOrganization(orgId: string) {
    await this.databaseService.db.delete(deviceRegistration).where(eq(deviceRegistration.id, orgId));
  }
}
