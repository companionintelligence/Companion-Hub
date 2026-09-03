import { describe, expect, it, vi } from 'vitest';
import { TRANSIENT_DB_RETRY_DELAYS_MS, withTransientDbRetry } from '../transient-db-retry';

describe('withTransientDbRetry', () => {
  it('returns on first success without delaying', async () => {
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(withTransientDbRetry(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries transient DNS failures then succeeds', async () => {
    const transient = Object.assign(new Error('getaddrinfo EAI_AGAIN ci-hub-db'), { code: 'EAI_AGAIN' });
    const operation = vi.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce('recovered');
    const onRetry = vi.fn();

    await expect(withTransientDbRetry(operation, { delaysMs: [1, 1], onRetry })).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(transient, 1, 3);
  });

  it('rethrows non-transient errors immediately', async () => {
    const bug = new Error('syntax error');
    const operation = vi.fn().mockRejectedValue(bug);

    await expect(withTransientDbRetry(operation, { delaysMs: [1] })).rejects.toBe(bug);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('rethrows the last transient error after exhausting retries', async () => {
    const transient = Object.assign(new Error('getaddrinfo EAI_AGAIN ci-hub-db'), { code: 'EAI_AGAIN' });
    const operation = vi.fn().mockRejectedValue(transient);

    await expect(withTransientDbRetry(operation, { delaysMs: [1, 1] })).rejects.toBe(transient);
    expect(operation).toHaveBeenCalledTimes(TRANSIENT_DB_RETRY_DELAYS_MS.length > 0 ? 3 : 1);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
