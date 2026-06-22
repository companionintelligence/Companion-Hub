import { describe, expect, it } from 'vitest';
import { appendToRollingBuffer, isHostPortBindConflict } from '../compose-up';

describe('compose-up helpers', () => {
  it('detects docker port bind conflicts in rolling buffer output', () => {
    const output = 'Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:80';
    expect(isHostPortBindConflict(output)).toBe(true);
  });

  it('keeps only the trailing portion of compose output', () => {
    const buffer = appendToRollingBuffer('abc', 'def');
    expect(buffer).toBe('abcdef');
    const large = 'x'.repeat(9000);
    const trimmed = appendToRollingBuffer(large, 'tail');
    expect(trimmed.length).toBeLessThanOrEqual(8192 + 4);
    expect(trimmed.endsWith('tail')).toBe(true);
  });
});
