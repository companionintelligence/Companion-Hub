import { describe, expect, it } from 'vitest';
import { optionalCpuLimitSchema } from '../cpu-limit';

describe('optionalCpuLimitSchema', () => {
  it('accepts valid positive decimal strings', () => {
    expect(optionalCpuLimitSchema.parse('1')).toBe('1');
    expect(optionalCpuLimitSchema.parse('0.5')).toBe('0.5');
    expect(optionalCpuLimitSchema.parse('2.0')).toBe('2.0');
  });

  it('rejects invalid CPU limit strings', () => {
    expect(() => optionalCpuLimitSchema.parse('abc')).toThrow();
    expect(() => optionalCpuLimitSchema.parse('-1')).toThrow();
    expect(() => optionalCpuLimitSchema.parse('0')).toThrow();
  });
});
