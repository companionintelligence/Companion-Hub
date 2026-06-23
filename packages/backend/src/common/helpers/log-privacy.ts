import { createHash } from 'node:crypto';

/** One-way hash for log correlation without storing plaintext email addresses. */
export function hashEmailForLog(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    return '[empty]';
  }

  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}
