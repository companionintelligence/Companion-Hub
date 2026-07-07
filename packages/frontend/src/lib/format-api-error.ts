import type { TFunction } from 'i18next';

import { TranslatableError } from '@/types/error.types';

import { isChunkLoadError } from './chunk-load-error';
import { normalizeApiErrorMessage } from './normalize-api-error';

const I18N_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;

function isI18nKey(message: string): boolean {
  return I18N_KEY_PATTERN.test(message);
}

/** Turn API or route errors into translated Uncloud copy (fact + fix). Never surfaces raw backend English. */
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

  if (isI18nKey(key)) {
    return t(key, intlParams ?? {});
  }

  return t('COMMON_AN_ERROR_OCCURRED');
}
