import type { ErrorEvent, EventHint } from '@sentry/node';
import { ApiKeyStoreUnavailableError, isTransientDbError } from '@/modules/api-keys/api-key.errors';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[_-]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
];

const HOME_PATH_PATTERNS = [
  /\/Users\/[^/\s]+/g, // macOS
  /\/home\/[^/\s]+/g, // Linux
  /[A-Za-z]:\\Users\\[^\\/\s]+/g, // Windows (backslash)
  /[A-Za-z]:\/Users\/[^/\s]+/g, // Windows (forward-slash)
];
const APPLICATION_SUPPORT_PATTERN = /Library\/Application Support\/[^\s]+/g;

export function scrubString(value: string): string {
  let scrubbed = value;
  for (const pattern of HOME_PATH_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '~');
  }
  scrubbed = scrubbed.replace(APPLICATION_SUPPORT_PATTERN, '…/Application Support/…');

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

function isTransientDbSentryNoise(event: ErrorEvent, hint: EventHint | undefined): boolean {
  const original = hint?.originalException;
  if (original instanceof ApiKeyStoreUnavailableError) {
    return true;
  }
  if (isTransientDbError(original)) {
    return true;
  }
  // Nest may wrap the driver error as ServiceUnavailableException with cause set.
  if (original instanceof Error && isTransientDbError(original.cause)) {
    return true;
  }

  const exceptionText = event.exception?.values?.map((value) => `${value.type ?? ''} ${value.value ?? ''}`).join(' ') ?? event.message ?? '';
  return /EAI_AGAIN|ENOTFOUND|ApiKeyStoreUnavailable|Database temporarily unavailable/i.test(exceptionText);
}

export function scrubEvent(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  // Docker DNS blips (`EAI_AGAIN ci-hub-db`) and exhausted auth-store retries are
  // infrastructure noise, not hub bugs. Keep one grouped warning so outages stay
  // visible without creating a new high-priority issue per failing query.
  if (isTransientDbSentryNoise(event, hint)) {
    event.level = 'warning';
    event.fingerprint = ['transient-db-unreachable'];
    event.tags = { ...event.tags, error_class: 'transient-db-unreachable' };
  }

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
