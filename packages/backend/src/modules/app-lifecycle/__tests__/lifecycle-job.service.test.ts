import { describe, it, expect, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import type { Database } from '@/core/database/database.module';
import type { LifecycleJob, NewLifecycleJob } from '@/core/database/drizzle/types';
import { LifecycleJobService } from '../lifecycle-job.service';

describe('LifecycleJobService', () => {
  let service: LifecycleJobService;
  let logger: ReturnType<typeof mock<LoggerService>>;
  let store: LifecycleJob[];

  beforeEach(() => {
    logger = mock<LoggerService>();
    store = [];

    const mockDb = {
      insert: () => ({
        values: (values: NewLifecycleJob) => ({
          returning: () => ({
            execute: async () => {
              const row: LifecycleJob = {
                id: values.id ?? 'test-uuid',
                appUrn: values.appUrn ?? null,
                operation: values.operation,
                status: values.status,
                progressPercent: values.progressPercent ?? 0,
                error: values.error ?? null,
                metadata: values.metadata ?? {},
                startedAt: values.startedAt ?? null,
                finishedAt: values.finishedAt ?? null,
                createdAt: values.createdAt ?? new Date().toISOString(),
                updatedAt: values.updatedAt ?? new Date().toISOString(),
              };
              store.push(row);
              return [row];
            },
          }),
        }),
      }),
      select: () => {
        const filtered = [...store];
        const chain: any = Object.assign(Promise.resolve(filtered), {
          from: () => chain,
          where: (_condition: any) => {
            return chain;
          },
          orderBy: () => chain,
          limit: (n: number) => filtered.slice(0, n),
          offset: (n: number) => filtered.slice(n),
        });
        return chain;
      },
      update: () => ({
        set: (updates: Partial<NewLifecycleJob>) => ({
          where: (_condition: any) => ({
            returning: () => ({
              execute: async () => {
                const target = store[0]; // for simplified mock or matched target
                if (!target) return [];
                Object.assign(target, updates);
                return [target];
              },
            }),
          }),
        }),
      }),
      delete: () => ({
        where: (_condition: any) => ({
          returning: () => ({
            execute: async () => {
              const deleted = store.splice(0, store.length);
              return deleted.map((d) => ({ id: d.id }));
            },
          }),
        }),
      }),
    } as unknown as Database;

    service = new LifecycleJobService(mockDb, logger);
  });

  it('creates a lifecycle job with defaults', async () => {
    const job = await service.createJob({
      operation: 'install',
      appUrn: 'ci-marketplace/photoprism',
    });

    expect(job).toBeDefined();
    expect(job.operation).toBe('install');
    expect(job.status).toBe('pending');
    expect(job.progressPercent).toBe(0);
    expect(job.appUrn).toBe('ci-marketplace/photoprism');
    expect(job.error).toBeNull();
    expect(job.finishedAt).toBeNull();
  });

  it('creates a running job with startedAt populated', async () => {
    const job = await service.createJob({
      operation: 'start',
      status: 'running',
      metadata: { initiatedBy: 'admin' },
    });

    expect(job.status).toBe('running');
    expect(job.startedAt).toBeTruthy();
    expect(job.metadata).toEqual({ initiatedBy: 'admin' });
  });

  it('updates job progress clamped between 0 and 100', async () => {
    await service.createJob({
      id: 'job-1',
      operation: 'install',
      status: 'running',
    });

    const updated = await service.updateProgress('job-1', 45);
    expect(updated?.progressPercent).toBe(45);

    const clampedOver = await service.updateProgress('job-1', 150);
    expect(clampedOver?.progressPercent).toBe(100);

    const clampedUnder = await service.updateProgress('job-1', -10);
    expect(clampedUnder?.progressPercent).toBe(0);
  });

  it('transitions through start, progress, and complete', async () => {
    await service.createJob({
      id: 'job-step',
      operation: 'backup',
    });

    const running = await service.startJob('job-step');
    expect(running?.status).toBe('running');
    expect(running?.startedAt).toBeTruthy();

    const progress = await service.updateProgress('job-step', 50);
    expect(progress?.progressPercent).toBe(50);

    const completed = await service.completeJob('job-step', { backupSize: '1.2GB' });
    expect(completed?.status).toBe('completed');
    expect(completed?.progressPercent).toBe(100);
    expect(completed?.finishedAt).toBeTruthy();
    expect((completed?.metadata as any)?.backupSize).toBe('1.2GB');
  });

  it('fails job with error details and finished timestamp', async () => {
    await service.createJob({
      id: 'job-fail',
      operation: 'install',
      status: 'running',
    });

    const failed = await service.failJob('job-fail', new Error('Port 8080 collision'));
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('Port 8080 collision');
    expect(failed?.finishedAt).toBeTruthy();
  });

  it('cancels job with optional reason', async () => {
    await service.createJob({
      id: 'job-cancel',
      operation: 'restore',
      status: 'running',
    });

    const cancelled = await service.cancelJob('job-cancel', 'User aborted operation');
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.error).toBe('User aborted operation');
    expect(cancelled?.finishedAt).toBeTruthy();
  });

  it('retrieves jobs by app and recent jobs', async () => {
    await service.createJob({
      id: 'job-a',
      appUrn: 'ci-marketplace/app-a',
      operation: 'install',
    });

    const jobs = await service.getJobsByApp('ci-marketplace/app-a');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.appUrn).toBe('ci-marketplace/app-a');

    const recent = await service.getRecentJobs(10);
    expect(recent).toHaveLength(1);
  });

  it('deletes and prunes old jobs', async () => {
    await service.createJob({
      id: 'job-old',
      operation: 'uninstall',
      status: 'completed',
    });

    const deleted = await service.deleteJob('job-old');
    expect(deleted).toBe(true);
  });
});
