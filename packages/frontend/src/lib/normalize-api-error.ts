/** Map generic HTTP status text to i18n keys when the API returns no translation key. */
const LITERAL_MESSAGE_ALIASES: Record<string, string> = {
  Unauthorized: 'SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN',
  Forbidden: 'REGISTRATION_DEVICE_NOT_OPERATIONAL',
};

const STATUS_FALLBACK_KEYS: Partial<Record<number, string>> = {
  401: 'SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN',
  403: 'REGISTRATION_DEVICE_NOT_OPERATIONAL',
};

/** Returns an i18n key (or passthrough message) suitable for `t()`. */
export function normalizeApiErrorMessage(message: string | undefined, status: number): string {
  if (message && /^[A-Z][A-Z0-9_]+$/.test(message)) {
    return message;
  }

  if (message && LITERAL_MESSAGE_ALIASES[message]) {
    return LITERAL_MESSAGE_ALIASES[message];
  }

  const statusFallback = STATUS_FALLBACK_KEYS[status];
  if (statusFallback) {
    return statusFallback;
  }

  return message || 'COMMON_AN_ERROR_OCCURRED';
}
