import axios from 'axios';
import { mock } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggerService } from '@/core/logger/logger.service';
import type { MemoryProviderResolver } from '@/modules/memory-connect/memory-provider.resolver';
import { MemoryApiKeyCheck } from '../memory-api-key.check';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const get = vi.mocked(axios.get);
const KEY = 'a'.repeat(64);

function setup() {
  const providers = mock<MemoryProviderResolver>();
  providers.findProvider.mockResolvedValue({ appUrn: 'ci-memory:ci-marketplace' as never, internalUrl: 'http://gateway:8642' });
  const check = new MemoryApiKeyCheck(providers, mock<LoggerService>());
  return { check, providers };
}

function answers(status: number) {
  get.mockResolvedValue({ status } as never);
}

describe('MemoryApiKeyCheck', () => {
  beforeEach(() => {
    get.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks Memory's check route over the internal network with the key", async () => {
    const { check } = setup();
    answers(204);

    await expect(check.check(KEY)).resolves.toBe('valid');
    expect(get).toHaveBeenCalledWith('http://gateway:8642/api/keys/check', expect.objectContaining({ headers: { 'x-api-key': KEY } }));
  });

  it('reads 401 and 403 as invalid, and anything else as unknown', async () => {
    for (const [status, verdict] of [
      [401, 'invalid'],
      [403, 'invalid'],
      [404, 'unknown'],
      [502, 'unknown'],
    ] as const) {
      const { check } = setup();
      answers(status);
      await expect(check.check(KEY), String(status)).resolves.toBe(verdict);
    }
  });

  it('remembers "valid" for a minute and "invalid" for half a minute, then asks again', async () => {
    const { check } = setup();
    answers(204);
    await check.check(KEY);
    await check.check(KEY);
    expect(get).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    answers(401);
    await expect(check.check(KEY)).resolves.toBe('invalid');
    expect(get).toHaveBeenCalledTimes(2);

    await check.check(KEY);
    expect(get).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(31_000);
    await check.check(KEY);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('never remembers "unknown": a Memory restarting is not a minute of refusals', async () => {
    const { check } = setup();
    get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(check.check(KEY)).resolves.toBe('unknown');

    answers(204);
    await expect(check.check(KEY)).resolves.toBe('valid');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('asks once for a burst of requests with the same key', async () => {
    const { check } = setup();
    let release: (value: unknown) => void = () => undefined;
    get.mockReturnValue(new Promise((resolve) => (release = resolve)) as never);

    const burst = Array.from({ length: 5 }, () => check.check(KEY));
    release({ status: 204 });

    await expect(Promise.all(burst)).resolves.toEqual(Array(5).fill('valid'));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps no raw key in memory', async () => {
    const { check } = setup();
    answers(204);
    await check.check(KEY);

    const stored = [...(check as unknown as { verdicts: Map<string, unknown> }).verdicts.keys()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(KEY);
    expect(stored[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is unknown, without asking, when no Memory is installed', async () => {
    const { check, providers } = setup();
    providers.findProvider.mockResolvedValue(null);

    await expect(check.check(KEY)).resolves.toBe('unknown');
    expect(get).not.toHaveBeenCalled();
  });
});
