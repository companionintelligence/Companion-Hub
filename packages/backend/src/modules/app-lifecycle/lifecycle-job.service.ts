import { DATABASE, type Database } from '@/core/database/database.module';
import { lifecycleJob } from '@/core/database/drizzle/schema';
import type { LifecycleJob, NewLifecycleJob } from '@/core/database/drizzle/types';
import { LoggerService } from '@/core/logger/logger.service';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

export type LifecycleJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CreateLifecycleJobParams {
  id?: string;
  appUrn?: string | null;
  operation: string;
  status?: LifecycleJobStatus | string;
  progressPercent?: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
  startedAt?: string;
}

export interface UpdateLifecycleJobParams {
  status?: LifecycleJobStatus | string;
  progressPercent?: number;
  error?: string | null;
  metadata?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
}

export interface ListLifecycleJobsFilter {
  appUrn?: string;
  operation?: string;
  status?: string | string[];
  limit?: number;
  offset?: number;
}

/**
 * Durable task state machine for tracking, persisting, and querying lifecycle operations.
 * State survives Hub API restarts and database reconnections.
 */
@Injectable()
export class LifecycleJobService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Create and persist a new lifecycle job.
   */
  async createJob(params: CreateLifecycleJobParams): Promise<LifecycleJob> {
    const id = params.id ?? randomUUID();
    const now = new Date().toISOString();
    const status = params.status ?? 'pending';
    const startedAt = params.startedAt ?? (status === 'running' ? now : undefined);

    const values: NewLifecycleJob = {
      id,
      appUrn: params.appUrn ?? null,
      operation: params.operation,
      status,
      progressPercent: params.progressPercent ?? 0,
      error: params.error ?? null,
      metadata: params.metadata ?? {},
      startedAt: startedAt ?? null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const [row] = await this.db.insert(lifecycleJob).values(values).returning().execute();
    if (!row) {
      throw new Error(`Failed to create lifecycle job for operation ${params.operation}`);
    }

    this.logger.info(`[lifecycle-job] created job ${row.id} op=${row.operation} status=${row.status} app=${row.appUrn ?? 'none'}`);
    return row;
  }

  /**
   * Update an existing lifecycle job by ID.
   */
  async updateJob(id: string, params: UpdateLifecycleJobParams): Promise<LifecycleJob | null> {
    const existing = await this.getJob(id);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const updates: Partial<NewLifecycleJob> = {
      updatedAt: now,
    };

    if (params.status !== undefined) {
      updates.status = params.status;
      if (params.status === 'running' && !existing.startedAt && !params.startedAt) {
        updates.startedAt = now;
      }
      if ((params.status === 'completed' || params.status === 'failed' || params.status === 'cancelled') && !params.finishedAt) {
        updates.finishedAt = now;
      }
    }

    if (params.progressPercent !== undefined) {
      updates.progressPercent = Math.max(0, Math.min(100, Math.round(params.progressPercent)));
    }

    if (params.error !== undefined) {
      updates.error = params.error;
    }

    if (params.metadata !== undefined) {
      const currentMeta = (existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}) as Record<string, unknown>;
      updates.metadata = { ...currentMeta, ...params.metadata };
    }

    if (params.startedAt !== undefined) {
      updates.startedAt = params.startedAt;
    }

    if (params.finishedAt !== undefined) {
      updates.finishedAt = params.finishedAt;
    }

    const [row] = await this.db.update(lifecycleJob).set(updates).where(eq(lifecycleJob.id, id)).returning().execute();

    if (row) {
      this.logger.debug?.(`[lifecycle-job] updated job ${id} status=${row.status} progress=${row.progressPercent}%`);
    }

    return row ?? null;
  }

  /**
   * Transition job to running state.
   */
  async startJob(id: string, metadata?: Record<string, unknown>): Promise<LifecycleJob | null> {
    return this.updateJob(id, {
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata,
    });
  }

  /**
   * Update progress percentage (0-100) of a running job.
   */
  async updateProgress(id: string, progressPercent: number, metadata?: Record<string, unknown>): Promise<LifecycleJob | null> {
    return this.updateJob(id, {
      progressPercent,
      metadata,
    });
  }

  /**
   * Mark job as successfully completed.
   */
  async completeJob(id: string, metadata?: Record<string, unknown>): Promise<LifecycleJob | null> {
    return this.updateJob(id, {
      status: 'completed',
      progressPercent: 100,
      finishedAt: new Date().toISOString(),
      metadata,
    });
  }

  /**
   * Mark job as failed with error details.
   */
  async failJob(id: string, error: string | Error, metadata?: Record<string, unknown>): Promise<LifecycleJob | null> {
    const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
    return this.updateJob(id, {
      status: 'failed',
      error: errorMessage,
      finishedAt: new Date().toISOString(),
      metadata,
    });
  }

  /**
   * Mark job as cancelled.
   */
  async cancelJob(id: string, reason?: string, metadata?: Record<string, unknown>): Promise<LifecycleJob | null> {
    return this.updateJob(id, {
      status: 'cancelled',
      error: reason ?? 'Operation was cancelled',
      finishedAt: new Date().toISOString(),
      metadata,
    });
  }

  /**
   * Retrieve a job by its unique ID.
   */
  async getJob(id: string): Promise<LifecycleJob | null> {
    const rows = await this.db.select().from(lifecycleJob).where(eq(lifecycleJob.id, id)).limit(1);

    return rows[0] ?? null;
  }

  /**
   * Query all lifecycle jobs for a specific app, most recent first.
   */
  async getJobsByApp(appUrn: string, limit = 20): Promise<LifecycleJob[]> {
    return this.db.select().from(lifecycleJob).where(eq(lifecycleJob.appUrn, appUrn)).orderBy(desc(lifecycleJob.createdAt)).limit(limit);
  }

  /**
   * Retrieve the active (pending or running) job for an app if one exists.
   */
  async getActiveJobForApp(appUrn: string): Promise<LifecycleJob | null> {
    const rows = await this.db
      .select()
      .from(lifecycleJob)
      .where(and(eq(lifecycleJob.appUrn, appUrn), inArray(lifecycleJob.status, ['pending', 'running'])))
      .orderBy(desc(lifecycleJob.createdAt))
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * Query recent lifecycle jobs across all apps.
   */
  async getRecentJobs(limit = 50): Promise<LifecycleJob[]> {
    return this.db.select().from(lifecycleJob).orderBy(desc(lifecycleJob.createdAt)).limit(limit);
  }

  /**
   * Query jobs with flexible filtering.
   */
  async listJobs(filter: ListLifecycleJobsFilter = {}): Promise<LifecycleJob[]> {
    const conditions = [];

    if (filter.appUrn) {
      conditions.push(eq(lifecycleJob.appUrn, filter.appUrn));
    }
    if (filter.operation) {
      conditions.push(eq(lifecycleJob.operation, filter.operation));
    }
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        conditions.push(inArray(lifecycleJob.status, filter.status));
      } else {
        conditions.push(eq(lifecycleJob.status, filter.status));
      }
    }

    let query = this.db.select().from(lifecycleJob);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    query = query.orderBy(desc(lifecycleJob.createdAt)) as typeof query;

    if (filter.limit) {
      query = query.limit(filter.limit) as typeof query;
    }
    if (filter.offset) {
      query = query.offset(filter.offset) as typeof query;
    }

    return query;
  }

  /**
   * Delete a job record by ID.
   */
  async deleteJob(id: string): Promise<boolean> {
    const result = await this.db.delete(lifecycleJob).where(eq(lifecycleJob.id, id)).returning({ id: lifecycleJob.id }).execute();

    return result.length > 0;
  }

  /**
   * Prune terminal (completed/failed/cancelled) jobs older than specified retention (ms).
   */
  async pruneOldJobs(olderThanMs = 14 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();

    const result = await this.db
      .delete(lifecycleJob)
      .where(and(inArray(lifecycleJob.status, ['completed', 'failed', 'cancelled']), lt(lifecycleJob.createdAt, cutoff)))
      .returning({ id: lifecycleJob.id })
      .execute();

    return result.length;
  }
}
