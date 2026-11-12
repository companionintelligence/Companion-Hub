import { hostTelemetrySample } from '@/core/database/drizzle/schema';
import type { LoggerService } from '@/core/logger/logger.service';
import { HostTelemetryService } from '@/modules/system/host-telemetry.service';
import type { SystemService } from '@/modules/system/system.service';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { type TestDatabase, createTestDatabase } from '../utils/create-test-database';

/*
 * `getWindow` against real Postgres: `date_bin` and the UTC window are SQL, so a mocked database
 * would only test that the query string is the one written. Rows are stored the way the collector
 * stores them, as UTC wall-clock time in a `timestamp` column with no zone.
 */
describe('Host telemetry window', () => {
  let db: TestDatabase;
  let service: HostTelemetryService;

  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const row = (msAgo: number, cpuLoad: number | null, memoryUsed: number | null) => ({
    sampledAt: at(msAgo),
    cpuLoad,
    memoryUsed,
    memoryTotal: 64,
    source: 'collector',
  });

  beforeAll(async () => {
    db = await createTestDatabase('hosttelemetrywindowtest');
    service = new HostTelemetryService(db as never, {} as never, mock<LoggerService>(), mock<SystemService>());
  });

  beforeEach(async () => {
    await db.delete(hostTelemetrySample);
  });

  it('keeps the 5-second points for 30 minutes and leaves out older rows', async () => {
    await db.insert(hostTelemetrySample).values([row(40 * 60_000, 99, 60), row(20_000, 10, 30), row(10_000, 20, 31)]);

    const window = await service.getWindow(30);

    expect(window.bucketSeconds).toBe(5);
    expect(window.minutes).toBe(30);
    expect(window.points.map((point) => point.cpuLoad)).toEqual([10, 20]);
    expect(window.points.every((point) => point.sampledAt.endsWith('Z'))).toBe(true);
  });

  it('averages a long window into buckets and says how long each one is', async () => {
    // Twelve readings inside the last minute and one an hour ago, all inside 24 hours.
    const recent = Array.from({ length: 12 }, (_, i) => row(5_000 * (i + 1), i % 2 === 0 ? 10 : 30, 40));
    await db.insert(hostTelemetrySample).values([...recent, row(60 * 60_000, 50, 50)]);

    const window = await service.getWindow(24 * 60);

    // 24 hours at 360 points is one point per 240 seconds.
    expect(window.bucketSeconds).toBe(240);
    expect(window.points.length).toBeLessThanOrEqual(3);
    const total = window.points.reduce((sum, point) => sum + (point.cpuLoad ?? 0), 0);
    expect(total).toBeGreaterThan(0);
    expect(window.points.find((point) => point.cpuLoad === 50)?.memoryUsed).toBe(50);
  });

  it('serves at most 360 points when every bucket holds a reading', async () => {
    // A reading every 5 seconds for 31 minutes, and one a minute for 6 hours and 10 minutes.
    await db.insert(hostTelemetrySample).values(Array.from({ length: 31 * 12 }, (_, i) => row(5_000 * i, 10, 40)));
    expect((await service.getWindow(30)).points.length).toBeLessThanOrEqual(360);

    await db.delete(hostTelemetrySample);
    await db.insert(hostTelemetrySample).values(Array.from({ length: 370 }, (_, i) => row(60_000 * i, 10, 40)));
    expect((await service.getWindow(360)).points.length).toBeLessThanOrEqual(360);
    expect((await service.getWindow(360)).points.length).toBeGreaterThan(350);
  });

  it('clamps a span past the retention and averages nulls away', async () => {
    await db.insert(hostTelemetrySample).values([row(5_000, null, null), row(5_000, 8, 12)]);

    const window = await service.getWindow(10_000);

    expect(window.minutes).toBe(48 * 60);
    expect(window.points).toHaveLength(1);
    expect(window.points[0]?.cpuLoad).toBe(8);
    expect(window.points[0]?.memoryTotal).toBe(64);
  });
});
