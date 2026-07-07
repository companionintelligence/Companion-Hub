import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { TranslatableError } from '@/types/error.types';

import { formatApiError } from './format-api-error';

const t = ((key: string) => key) as TFunction;

describe('formatApiError', () => {
  it('translates TranslatableError i18n keys', () => {
    expect(formatApiError(new TranslatableError('AUTH_ERROR_INVALID_CREDENTIALS'), t, 400)).toBe('AUTH_ERROR_INVALID_CREDENTIALS');
  });

  it('maps literal Unauthorized to a login message key', () => {
    expect(formatApiError(new Error('Unauthorized'), t, 401)).toBe('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
  });

  it('falls back when the message is raw backend English', () => {
    expect(formatApiError(new Error('Portal returned HTTP 502 for the store catalog.'), t)).toBe('COMMON_AN_ERROR_OCCURRED');
  });

  it('maps chunk load failures to a refresh hint', () => {
    expect(formatApiError(new TypeError('Failed to fetch dynamically imported module'), t)).toBe('ERROR_PAGE_CHUNK_LOAD');
  });
});
