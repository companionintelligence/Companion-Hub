import type { ErrorEvent, EventHint } from '@sentry/node';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[_-]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
];

const HOME_PATH_PATTERN = /\/Users\/[^/\s]+/g;
const APPLICATION_SUPPORT_PATTERN = /Library\/Application Support\/[^\s]+/g;

export function scrubString(value: string): string {
  let scrubbed = value.replace(HOME_PATH_PATTERN, '~/…').replace(APPLICATION_SUPPORT_PATTERN, '…/Application Support/…');

  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[Filtered]');
  }

  if (scrubbed.length > 8000) {
    return `${scrubbed.slice(0, 8000)}… [truncated]`;
  }

  return scrubbed;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubString(value);
  }

  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/password|secret|token|authorization|cookie|jwt|apikey|api_key/i.test(key)) {
        result[key] = '[Filtered]';
      } else {
        result[key] = scrubValue(nested);
      }
    }
    return result;
  }

  return value;
}

export function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  if (event.message) {
    event.message = scrubString(event.message);
  }

  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.value) {
        exception.value = scrubString(exception.value);
      }
    }
  }

  if (event.extra) {
    event.extra = scrubValue(event.extra) as Record<string, unknown>;
  }

  if (event.breadcrumbs) {
    for (const breadcrumb of event.breadcrumbs) {
      if (typeof breadcrumb.message === 'string') {
        breadcrumb.message = scrubString(breadcrumb.message);
      }
    }
  }

  return event;
}
