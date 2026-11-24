// vendored-from: @companionintelligence/native@0.1.0 packages/native/src/errors.ts
/**
 * Errors thrown by the native sign-in runtime. Identity-contract errors from
 * `@companionintelligence/auth` (StateMismatchError, AuthorizationDeniedError,
 * MissingCodeError, TokenRequestError, UnsafeRedirectUriError) pass through
 * unchanged, so an app can `instanceof` them from the auth package.
 */

/** The user, or the caller's AbortSignal, cancelled the sign-in before a callback arrived. */
export class SignInCancelledError extends Error {
  constructor(message = 'sign-in was cancelled') {
    super(message);
    this.name = 'SignInCancelledError';
  }
}

/**
 * The client was signed out on this device, so the refresh cannot run. refreshSession rejects with
 * it after signOut, and for a refresh that a signOut overtook. Nothing is written when it is thrown.
 * runSignIn for the same client clears the mark that causes it.
 */
export class SignedOutError extends Error {
  constructor(message = 'the client was signed out on this device') {
    super(message);
    this.name = 'SignedOutError';
  }
}

/**
 * The sign-in cannot continue: the platform replied with the wrong shape, the
 * callback URL is for another redirect target, or a driver was used out of order.
 */
export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

/** The secure store replied with a shape it should not have. The message never includes a value. */
export class SecureStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecureStoreError';
  }
}
