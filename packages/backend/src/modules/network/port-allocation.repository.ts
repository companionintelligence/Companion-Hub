import { DATABASE, type Database } from '@/core/database/database.module';
import { portAllocation } from '@/core/database/drizzle/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PortAllocation } from './port-manager.service';

@Injectable()
export class PortAllocationRepository {
  constructor(@Inject(DATABASE) private db: Database) {}

  public async create(data: {
    appUrn: string;
    hostPort: number;
    containerPort: number;
    protocol: 'tcp' | 'udp';
    label: string;
  }): Promise<PortAllocation> {
    const [result] = await this.db
      .insert(portAllocation)
      .values({
        appUrn: data.appUrn,
        hostPort: data.hostPort,
        containerPort: data.containerPort,
        protocol: data.protocol,
        label: data.label,
      })
      .returning()
      .execute();
    return result as PortAllocation;
  }

  public async getByAppUrn(appUrn: string): Promise<PortAllocation[]> {
    return this.db.query.portAllocation.findMany({
      where: eq(portAllocation.appUrn, appUrn),
    }) as Promise<PortAllocation[]>;
  }

  public async getByHostPort(port: number, protocol: 'tcp' | 'udp'): Promise<PortAllocation | undefined> {
    return this.db.query.portAllocation.findFirst({
      where: and(eq(portAllocation.hostPort, port), eq(portAllocation.protocol, protocol)),
    }) as Promise<PortAllocation | undefined>;
  }

  public async getAllHostPorts(protocol: 'tcp' | 'udp'): Promise<number[]> {
    const rows = await this.db.query.portAllocation.findMany({
      where: eq(portAllocation.protocol, protocol),
      columns: { hostPort: true },
    });
    return rows.map((r) => r.hostPort);
  }

  public async getAll(): Promise<PortAllocation[]> {
    return this.db.query.portAllocation.findMany() as Promise<PortAllocation[]>;
  }

  public async deleteByAppUrn(appUrn: string): Promise<number> {
    const result = await this.db.delete(portAllocation).where(eq(portAllocation.appUrn, appUrn)).returning().execute();
    return result.length;
  }

  public async deleteByHostPort(port: number, protocol: 'tcp' | 'udp'): Promise<void> {
    await this.db
      .delete(portAllocation)
      .where(and(eq(portAllocation.hostPort, port), eq(portAllocation.protocol, protocol)))
      .execute();
  }
}
