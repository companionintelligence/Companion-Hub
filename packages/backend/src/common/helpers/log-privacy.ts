import { createHash } from 'node:crypto';

/** One-way hash for log correlation without storing plaintext email addresses. */
export function hashEmailForLog(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    return '[empty]';
  }

  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

const REDACTED = '[redacted]';
const TOO_DEEP = '[nested too deep]';

/**
 * Names of fields that hold a credential: in the configuration (`jwtSecret`, `ciHubApiKey`,
 * `hubLocalKey`), in request bodies (`newPassword`, `token`) and among the variables an app's install
 * form posts (`ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`, `SAMBA_PASS`). `pass`, `pwd`, `psw` and `pw`
 * count only as the whole name or its last `_` part, so `bypass` is not one.
 */
const SECRET_FIELD_PATTERN = /password|passphrase|secret|token|credential|keys?$|(?:^|_)(?:pass|pwd|psw|pw)$/i;

/**
 * Credentials the pattern cannot tell apart from the metadata stored beside them. The pending push key
 * is the raw key, kept until Portal confirms it holds a copy; `portalPushKeyPrefix` is only the
 * fingerprint the UI shows, so it stays readable.
 */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set(['portalPushKeyPending']);

/** A plural `tokens` names a count (`hubPoolMaxPromptTokens`), never a credential. */
const TOKEN_COUNT_PATTERN = /tokens$/i;

/**
 * A copy of `value`, such as the configuration or a request body, that is safe to log: at any depth,
 * every credential field holds `[redacted]` instead of its value. The input is left unchanged.
 *
 * Only a non-empty string, a number, or an object or list held under a credential's name, is
 * replaced. A number counts because the auth guard logs a body before validation rejects it, so a
 * password or PIN sent as a JSON number would reach the log as sent. A flag named after a credential
 * (`disablePasswordReset`), a token count (`hubPoolMaxPromptTokens`), and an empty or null credential
 * keep their value, because whether a credential is set is what a reader of the log needs to know.
 */
export function redactSecretsForLog(value: unknown): unknown {
  return redact(value, 0);
}

/**
 * How deep the copy goes. The configuration and the Hub's request bodies are a few levels deep, but the
 * auth guard copies a body before it checks who sent it, so a body nested thousands of levels deep would
 * overflow the stack and turn a 401 into a 500. Past this depth the rest is replaced whole, which also
 * ends a circular object.
 */
const MAX_DEPTH = 32;

function redact(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return TOO_DEEP;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, isCredential(key, field) ? REDACTED : redact(field, depth + 1)]));
}

function isCredential(name: string, value: unknown): boolean {
  if (!SECRET_FIELD_PATTERN.test(name) && !SECRET_FIELD_NAMES.has(name)) {
    return false;
  }
  if (typeof value === 'number') {
    return !TOKEN_COUNT_PATTERN.test(name);
  }

  return typeof value === 'string' ? value !== '' : typeof value === 'object' && value !== null;
}
