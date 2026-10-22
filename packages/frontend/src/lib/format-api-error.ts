import type { TFunction } from 'i18next';

import { TranslatableError } from '@/types/error.types';

import { isChunkLoadError } from './chunk-load-error';
import { normalizeApiErrorMessage } from './normalize-api-error';

const I18N_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;

/** Whether an API `message` is a translation key, as opposed to raw backend text that is not copy for the screen. */
export function isI18nKey(message: string): boolean {
  return I18N_KEY_PATTERN.test(message);
}

/** A 409 from the API, such as an app refusing a change while another operation holds it. Its message says why. */
export function isConflictError(error: unknown): error is TranslatableError {
  return error instanceof TranslatableError && error.http?.status === 409;
}

/** Turn API or route errors into translated user-facing copy (fact + fix). Never surfaces raw backend English. */
export function formatApiError(error: unknown, t: TFunction, status = 500): string {
  if (isChunkLoadError(error)) {
    return t('ERROR_PAGE_CHUNK_LOAD');
  }

  let message: string | undefined;
  let intlParams: Record<string, string> | undefined;

  if (error instanceof TranslatableError) {
    message = error.message;
    intlParams = error.intlParams;
  } else if (error instanceof Error) {
    message = error.message;
  }

  const key = normalizeApiErrorMessage(message, status);
  const fallback = t('COMMON_AN_ERROR_OCCURRED');

  if (isI18nKey(key)) {
    return t(key, { ...(intlParams ?? {}), defaultValue: fallback });
  }

  return fallback;
}
