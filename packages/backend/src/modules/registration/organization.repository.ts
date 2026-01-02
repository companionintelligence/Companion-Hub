import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@/core/database/database.service';
import { organization } from '@/core/database/drizzle/schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class OrganizationRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async getOrganizationById(orgId: string) {
    const result = await this.databaseService.db
      .select()
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1);

    return result[0] || null;
  }

  async createOrganization(data: {
    id: string;
    name: string;
    tunnelId: string;
    domain: string;
  }) {
    const result = await this.databaseService.db
      .insert(organization)
      .values(data)
      .returning();

    return result[0];
  }

  async updateOrganization(orgId: string, data: Partial<{
    name: string;
    tunnelId: string;
    domain: string;
  }>) {
    const result = await this.databaseService.db
      .update(organization)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(organization.id, orgId))
      .returning();

    return result[0] || null;
  }

  async hasAnyOrganization(): Promise<boolean> {
    const result = await this.databaseService.db
      .select()
      .from(organization)
      .limit(1);

    return result.length > 0;
  }

  async getFirstOrganization() {
    const result = await this.databaseService.db
      .select()
      .from(organization)
      .limit(1);

    return result[0] || null;
  }

  async deleteOrganization(orgId: string) {
    await this.databaseService.db
      .delete(organization)
      .where(eq(organization.id, orgId));
  }
}

