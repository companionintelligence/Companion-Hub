import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DatabaseService } from '../database.service';
import type { ConfigurationService } from '../../config/configuration.service';
import type { LoggerService } from '../../logger/logger.service';

describe('DatabaseService.waitUntilReady', () => {
  const configurationService = mock<ConfigurationService>();
  const logger = mock<LoggerService>();
  let service: DatabaseService;
  let query: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    configurationService.get.mockImplementation((key: string) => {
      if (key === 'database') {
        return { username: 'u', password: 'p', host: 'db', port: 5432, database: 'd' };
      }
      return {};
    });
    service = new DatabaseService(configurationService, logger);
    query = vi.fn();
    // Replace the real pool with a stub — no sockets in unit tests.
    Object.assign(service as unknown as { pool: { query: typeof query } }, { pool: { query } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the database answers', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(service.waitUntilReady()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures until the database answers', async () => {
    query
      .mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN ci-hub-db'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ rows: [] });

    const pending = service.waitUntilReady();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    query.mockRejectedValue(new Error('getaddrinfo EAI_AGAIN ci-hub-db'));

    const pending = service.waitUntilReady();
    pending.catch(() => {}); // avoid unhandled rejection while timers run
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toThrow('EAI_AGAIN');
    expect(query).toHaveBeenCalledTimes(30);
  });
});
