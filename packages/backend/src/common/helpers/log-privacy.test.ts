import { describe, expect, it } from 'vitest';
import { hashEmailForLog } from './log-privacy';

describe('hashEmailForLog', () => {
  it('returns a stable truncated hash for the same email', () => {
    expect(hashEmailForLog('User@Example.com')).toBe(hashEmailForLog('user@example.com'));
    expect(hashEmailForLog('user@example.com')).toHaveLength(12);
  });

  it('returns a placeholder for empty input', () => {
    expect(hashEmailForLog('   ')).toBe('[empty]');
  });
});
