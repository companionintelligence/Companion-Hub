// vendored-from: @companionintelligence/auth@0.0.0 packages/auth/src/callback.ts
/**
 * Parse the redirect back from the authorization endpoint.
 *
 * The state is checked first, in constant time, before any error or code is read.
 * A callback that does not carry our state cannot report a denial or supply a code.
 * Error messages never include the callback URL, the code or the state.
 */
import { constantTimeEqual } from './internal.js';

/** The callback carries no state, a different state, or more than one state. */
export class StateMismatchError extends Error {
  constructor() {
    super('authorization response state does not match the request');
    this.name = 'StateMismatchError';
  }
}

/** The callback has the right state and no error, but no usable authorization code. */
export class MissingCodeError extends Error {
  constructor() {
    super('authorization response has no authorization code');
    this.name = 'MissingCodeError';
  }
}

/**
 * The authorization server denied the request, or returned an error. Carries the
 * OAuth error code and the description. It never carries tokens, the code or the
 * callback URL.
 */
export class AuthorizationDeniedError extends Error {
  /** OAuth error code, such as `access_denied`. Normalized to `unrecognized_error` when malformed. */
  readonly oauthError: string;
  /** Human-readable description from the server, truncated to 256 characters. */
  readonly errorDescription: string | undefined;

  constructor(oauthError: string, errorDescription?: string) {
    super(`authorization was denied: ${oauthError}`);
    this.name = 'AuthorizationDeniedError';
    this.oauthError = oauthError;
    this.errorDescription = errorDescription;
  }
}

export interface AuthorizationCode {
  /** The one-time authorization code, to exchange at the token endpoint with the verifier. */
  readonly code: string;
}

/** OAuth error codes are lowercase words joined by underscores. */
const OAUTH_ERROR_PATTERN = /^[a-z_]{1,64}$/;
const MAX_DESCRIPTION_LENGTH = 256;

/**
 * Validate the callback URL against the state we sent and return the code.
 *
 * Throws {@link StateMismatchError} when the state is missing, differs or is
 * duplicated. Throws {@link AuthorizationDeniedError} when the state matches and the
 * server sent `error`. Throws {@link MissingCodeError} when there is no single,
 * non-empty `code`. An unparseable callback URL is reported as a missing code.
 */
export function parseAuthorizationResponse(callbackUrl: string, expectedState: string): AuthorizationCode {
  let params: URLSearchParams;
  try {
    params = new URL(callbackUrl).searchParams;
  } catch {
    throw new MissingCodeError();
  }

  // Duplicated parameters are ambiguous, so they count as a mismatch instead of picking one.
  const states = params.getAll('state');
  const received = states.length === 1 ? states[0] : undefined;
  if (expectedState === '' || received === undefined || !constantTimeEqual(received, expectedState)) {
    throw new StateMismatchError();
  }

  const error = params.get('error');
  if (error !== null) {
    const description = params.get('error_description');
    throw new AuthorizationDeniedError(
      OAUTH_ERROR_PATTERN.test(error) ? error : 'unrecognized_error',
      description === null ? undefined : description.slice(0, MAX_DESCRIPTION_LENGTH),
    );
  }

  const codes = params.getAll('code');
  const code = codes.length === 1 ? codes[0] : undefined;
  if (code === undefined || code === '') {
    throw new MissingCodeError();
  }
  return { code };
}
