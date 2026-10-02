import { describe, expect, it } from 'vitest';
import { meetsPasswordComplexity, PASSWORD_COMPLEXITY_REGEX } from '../password-policy.js';

describe('meetsPasswordComplexity', () => {
  it('accepts a password with each required kind of character', () => {
    expect(meetsPasswordComplexity('Password1!')).toBe(true);
    expect(PASSWORD_COMPLEXITY_REGEX.test('Password1!')).toBe(true);
  });

  it('rejects a password missing a required kind of character', () => {
    expect(meetsPasswordComplexity('password1!')).toBe(false);
    expect(meetsPasswordComplexity('Password!')).toBe(false);
    expect(meetsPasswordComplexity('Pass1')).toBe(false);
  });
});
