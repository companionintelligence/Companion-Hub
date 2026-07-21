import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';

import { getCategoryLabel } from './category-label';

function makeTranslator(map: Record<string, string> = {}): TFunction {
  return ((key: string) => map[key] ?? key) as unknown as TFunction;
}

describe('getCategoryLabel', () => {
  it('returns translated labels when key exists', () => {
    const t = makeTranslator({ COMMON_AI: 'AI' });
    expect(getCategoryLabel(t, 'ai')).toBe('AI');
  });

  it('falls back to a humanized label for unknown categories', () => {
    const t = makeTranslator();
    expect(getCategoryLabel(t, 'some-unknown-category')).toBe('Some Unknown Category');
  });

  it('handles APP_CATEGORY_ prefixed values and hyphens', () => {
    const t = makeTranslator({ APP_CATEGORY_COMPANION_INTELLIGENCE: 'CI' });
    expect(getCategoryLabel(t, 'companion-intelligence')).toBe('CI');
    expect(getCategoryLabel(t, 'APP_CATEGORY_COMPANION-INTELLIGENCE')).toBe('CI');
  });
});
