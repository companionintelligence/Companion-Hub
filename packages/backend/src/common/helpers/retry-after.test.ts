import { describe, expect, it } from 'vitest';
import { parseRetryAfterSeconds, rateLimitedWaitCopy, readResponseHeader } from './retry-after';

describe('retry-after', () => {
  it('reads Axios-style lowercase headers', () => {
    expect(readResponseHeader({ 'retry-after': '12' }, 'Retry-After')).toBe('12');
  });

  it('reads Fetch Headers.get', () => {
    expect(readResponseHeader({ get: (name: string) => (name.toLowerCase() === 'retry-after' ? '7' : null) }, 'Retry-After')).toBe('7');
  });

  it('parses delta-seconds', () => {
    expect(parseRetryAfterSeconds({ 'retry-after': '9.2' })).toBe(10);
  });

  it('returns undefined when the header is missing', () => {
    expect(parseRetryAfterSeconds({})).toBeUndefined();
  });

  it('surfaces wait copy with the parsed delay', () => {
    expect(rateLimitedWaitCopy({ 'retry-after': '15' })).toBe('Too many attempts. Try again in 15 seconds.');
  });

  it('surfaces generic wait copy without a header', () => {
    expect(rateLimitedWaitCopy({})).toBe('Too many attempts. Please wait a moment and try again.');
  });
});
