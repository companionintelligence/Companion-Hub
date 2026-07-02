import type { TFunction } from 'i18next';

type ApiErrorBody = {
  message?: string | string[];
  messageKey?: string;
  intlParams?: Record<string, string | number>;
  statusCode?: number;
};

/** Parse a failed fetch Response into a user-visible message via i18n keys when available. */
export async function parseApiError(response: Response, t: TFunction): Promise<string> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    /* non-JSON */
  }

  if (body?.messageKey) {
    return t(body.messageKey, body.intlParams ?? {});
  }

  const raw = body?.message;
  if (Array.isArray(raw)) {
    return raw.join(' ');
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw;
  }

  return t('COMMON_AN_ERROR_OCCURRED');
}
