import { describe, expect, it } from 'vitest';
import { MAX_SSE_RETRY_DELAY_MS, getSseRetryDelayMs } from './use-sse';

describe('getSseRetryDelayMs', () => {
  it('uses exponential backoff capped at one minute', () => {
    expect(getSseRetryDelayMs(1)).toBe(2_000);
    expect(getSseRetryDelayMs(2)).toBe(4_000);
    expect(getSseRetryDelayMs(5)).toBe(32_000);
    expect(getSseRetryDelayMs(6)).toBe(MAX_SSE_RETRY_DELAY_MS);
    expect(getSseRetryDelayMs(10)).toBe(MAX_SSE_RETRY_DELAY_MS);
  });
});
