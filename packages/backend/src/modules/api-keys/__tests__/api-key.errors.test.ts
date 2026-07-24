import { describe, expect, it } from 'vitest';
import { ApiKeyStoreUnavailableError, isTransientDbError } from '../api-key.errors';

/** Mimics DrizzleQueryError: wraps the driver failure as `cause`. */
function wrapped(code?: string, message = 'boom'): Error {
  const inner = Object.assign(new Error(message), code ? { code } : {});
  return new Error('Failed query: SELECT ... FROM api_keys', { cause: inner });
}

describe('isTransientDbError', () => {
  it('classifies the exact #933 failure — EAI_AGAIN wrapped by Drizzle — as transient', () => {
    expect(isTransientDbError(wrapped('EAI_AGAIN', 'getaddrinfo EAI_AGAIN ci-hub-db'))).toBe(true);
  });

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'])('classifies %s as transient', (code) => {
    expect(isTransientDbError(wrapped(code))).toBe(true);
  });

  it('classifies Postgres connection-class SQLSTATEs (08xxx, 57P03) as transient', () => {
    expect(isTransientDbError(wrapped('08006'))).toBe(true);
    expect(isTransientDbError(wrapped('57P03', 'the database system is starting up'))).toBe(true);
  });

  it('classifies pool connect-timeout / terminated-connection messages as transient', () => {
    expect(isTransientDbError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('does NOT classify a plain query failure as transient', () => {
    // 42P01 = undefined_table: a real bug that retrying can never fix.
    expect(isTransientDbError(wrapped('42P01', 'relation "api_keys" does not exist'))).toBe(false);
    expect(isTransientDbError(new Error('syntax error at or near'))).toBe(false);
    expect(isTransientDbError('not even an error')).toBe(false);
  });

  it('survives a cyclic cause chain without hanging', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(isTransientDbError(a)).toBe(false);
  });
});

describe('ApiKeyStoreUnavailableError', () => {
  it('carries the original failure as cause', () => {
    const inner = wrapped('EAI_AGAIN');
    const err = new ApiKeyStoreUnavailableError(inner);
    expect(err.cause).toBe(inner);
    expect(err.name).toBe('ApiKeyStoreUnavailableError');
  });
});
