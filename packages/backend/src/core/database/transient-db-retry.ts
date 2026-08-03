import { isTransientDbError } from '@/modules/api-keys/api-key.errors';

/**
 * Default backoff for request-path DB retries (#933 lineage). Short and bounded so a
 * Docker DNS hiccup (`EAI_AGAIN ci-hub-db`) can clear without holding clients hostage.
 */
export const TRANSIENT_DB_RETRY_DELAYS_MS: readonly number[] = [150, 400];

export type TransientDbRetryOptions = {
  delaysMs?: readonly number[];
  onRetry?: (error: unknown, attempt: number, maxAttempts: number) => void;
};

/**
 * Run `operation`, retrying only errors classified as transient infrastructure failures
 * (DNS, refused/reset connections, Postgres still starting). Non-transient errors rethrow
 * immediately. After all attempts are exhausted, rethrows the last error.
 */
export async function withTransientDbRetry<T>(operation: () => Promise<T>, options: TransientDbRetryOptions = {}): Promise<T> {
  const delaysMs = options.delaysMs ?? TRANSIENT_DB_RETRY_DELAYS_MS;
  const maxAttempts = delaysMs.length + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt - 1]));
    }
    try {
      return await operation();
    } catch (err) {
      if (!isTransientDbError(err)) {
        throw err;
      }
      lastError = err;
      options.onRetry?.(err, attempt + 1, maxAttempts);
    }
  }

  throw lastError;
}
