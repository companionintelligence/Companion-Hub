import { describe, expect, it } from 'vitest';
import { meetsPasswordComplexity, PASSWORD_COMPLEXITY_REGEX } from './password-policy';

describe('password-policy', () => {
  it('accepts passwords that meet complexity requirements', () => {
    expect(meetsPasswordComplexity('Password1!')).toBe(true);
    expect(PASSWORD_COMPLEXITY_REGEX.test('Password1!')).toBe(true);
  });

  it('rejects passwords missing required character classes', () => {
    expect(meetsPasswordComplexity('password1!')).toBe(false);
    expect(meetsPasswordComplexity('Password!')).toBe(false);
    expect(meetsPasswordComplexity('Pass1')).toBe(false);
  });
});
