// vendored-from: @companionintelligence/native@0.1.0 packages/native/src/sign-in.ts
/**
 * The sign-in flow for a native wrapper: PKCE, the authorize URL, the platform
 * driver, the callback, the token exchange, and the secure store.
 *
 * Only the refresh token is persisted, under `ci.auth.<clientId>.refresh`. The access
 * token goes to the app in memory. The PKCE verifier is never stored, and it leaves
 * this module only in the token request body. Tokens never go into URLs, logs or
 * localStorage.
 */
import { deriveEndpoints } from '@companionintelligence/auth/config';
import { assertSafeRedirectUri, buildAuthorizeUrl } from '@companionintelligence/auth/authorize';
import { parseAuthorizationResponse } from '@companionintelligence/auth/callback';
import { createPkcePair, createStateNonce } from '@companionintelligence/auth/pkce';
import {
  exchangeAuthorizationCode,
  refreshTokens,
  TokenRequestError,
  type FetchLike,
  type TokenResponse,
} from '@companionintelligence/auth/token';

import { SignedOutError, SignInCancelledError } from './errors.js';
import type { SignInDriver } from './driver.js';
import type { SecureStore } from './store.js';

export interface NativeEndpoints {
  readonly authorization: string;
  readonly token: string;
}

interface NativeAuthCommon {
  /** Public client id registered with Portal, such as `ci-hub`. */
  readonly clientId: string;
  /** Requested scopes, usually `['openid', 'email', 'profile']`. */
  readonly scopes: readonly string[];
  /** Custom redirect schemes the app allows, such as `['cihub']`. Https and loopback http are always allowed. */
  readonly allowedSchemes?: readonly string[];
}

/** Give exactly one of `issuer` (the Portal origin) or `endpoints`. */
export type NativeAuthConfig =
  | (NativeAuthCommon & { readonly issuer: string; readonly endpoints?: undefined })
  | (NativeAuthCommon & { readonly endpoints: NativeEndpoints; readonly issuer?: undefined });

/** The signed-in session the app holds in memory. It contains no refresh token and no id token. */
export interface SignedInSession {
  /** Bearer access token for Portal-protected APIs. */
  readonly accessToken: string;
  /** Absolute expiry, in epoch ms. */
  readonly expiresAt: number;
  /** Granted scopes, as the server returned them. */
  readonly scope?: string;
}

export interface RunSignInOptions {
  readonly config: NativeAuthConfig;
  readonly driver: SignInDriver;
  readonly store: SecureStore;
  /** Abort to cancel. The sign-in then rejects with SignInCancelledError. */
  readonly signal?: AbortSignal;
  /** Injected fetch. Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Clock in epoch ms. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Timeout for the token request, in ms. Defaults to 15000. */
  readonly timeoutMs?: number;
}

export interface RefreshSessionOptions {
  readonly config: NativeAuthConfig;
  readonly store: SecureStore;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface SignOutOptions {
  readonly clientId: string;
  readonly store: SecureStore;
}

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The secure-store key that holds the refresh token for one client. */
export function refreshTokenKey(clientId: string): string {
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new TypeError('clientId must be a plain identifier such as ci-hub');
  }
  return `ci.auth.${clientId}.refresh`;
}

function resolveEndpoints(config: NativeAuthConfig): NativeEndpoints {
  if (config.issuer !== undefined && config.endpoints !== undefined) {
    throw new TypeError('config takes an issuer or endpoints, not both');
  }
  if (config.issuer !== undefined) {
    const { authorization, token } = deriveEndpoints(config.issuer);
    return { authorization, token };
  }
  if (config.endpoints !== undefined) return config.endpoints;
  throw new TypeError('config needs an issuer or endpoints');
}

function toSession(tokens: TokenResponse): SignedInSession {
  return {
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
  };
}

/** Best-effort release. The sign-in error is the one to report, so a failed cancel is ignored. */
async function releaseDriver(driver: SignInDriver): Promise<void> {
  try {
    await driver.cancel?.();
  } catch {
    // ignored on purpose, see above
  }
}

/** Reject with SignInCancelledError once the caller's signal has fired. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SignInCancelledError();
}

/**
 * The fetch for the token request, aborted by the sign-in signal as well as by the
 * request's own timeout. This needs `AbortSignal.any` (Node 20.3+, Safari 17.4+). Without
 * it the request runs to completion, and runSignIn still checks the signal before it stores anything.
 */
function cancellableFetch(fetch: FetchLike | undefined, signal: AbortSignal | undefined): FetchLike | undefined {
  if (signal === undefined || typeof AbortSignal.any !== 'function') return fetch;
  const send: FetchLike = fetch ?? ((input, init) => globalThis.fetch(input, init));
  return (input, init) =>
    send(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

/**
 * Run an interactive sign-in and return the session.
 *
 * The steps: prepare the driver's redirect, check it against `allowedSchemes`, build
 * the PKCE pair and the state, build the authorize URL, run the driver, parse the
 * callback (state checked in constant time), exchange the code with the verifier, and
 * persist the refresh token. Any failure after prepare releases the driver.
 *
 * Aborting `signal` cancels the sign-in at any step. The token request is aborted too,
 * and the signal is checked again after the exchange and before anything is stored. A cancel
 * while the write waits behind the client's refreshes rejects at once, and the queued write then
 * stores nothing, so a cancelled sign-in persists nothing. A cancel that lands during the store
 * write cannot undo it.
 *
 * Errors from the identity contract (StateMismatchError, AuthorizationDeniedError,
 * MissingCodeError, TokenRequestError) pass through unchanged. A cancel rejects with
 * SignInCancelledError, even when the token request fails because it was aborted.
 */
export async function runSignIn(options: RunSignInOptions): Promise<SignedInSession> {
  const { config, driver, store, signal, fetch, now, timeoutMs } = options;
  const endpoints = resolveEndpoints(config);
  const key = refreshTokenKey(config.clientId);
  if (signal?.aborted) throw new SignInCancelledError();

  try {
    const redirect = await driver.prepare();
    assertSafeRedirectUri(redirect.redirectUri, { allowedSchemes: config.allowedSchemes ?? [] });

    const pkce = await createPkcePair();
    const state = createStateNonce();
    const authorizationUrl = buildAuthorizeUrl({
      authorizationEndpoint: endpoints.authorization,
      clientId: config.clientId,
      redirectUri: redirect.redirectUri,
      scopes: config.scopes,
      state,
      codeChallenge: pkce.challenge,
    });

    const callbackUrl = await driver.start({
      authorizationUrl,
      redirectUri: redirect.redirectUri,
      callbackScheme: redirect.callbackScheme,
      signal,
    });
    const { code } = parseAuthorizationResponse(callbackUrl, state);

    throwIfCancelled(signal);
    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: endpoints.token,
      clientId: config.clientId,
      code,
      redirectUri: redirect.redirectUri,
      codeVerifier: pkce.verifier,
      fetch: cancellableFetch(fetch, signal),
      now,
      timeoutMs,
    }).catch((error: unknown) => {
      // An abort in flight fails the request. Report it as the cancel it is.
      throwIfCancelled(signal);
      throw error;
    });

    // A cancel that landed during the response must not reach the store.
    throwIfCancelled(signal);
    // The write waits in the client's queue behind any sign-out already queued, so that sign-out
    // cannot remove the token this sign-in stores. A cancel during that wait rejects at once, and
    // the queued write checks the signal again before it stores anything.
    const generation = signOutGeneration(config.clientId);
    await queueRefresh(
      key,
      async () => {
        throwIfCancelled(signal);
        if (tokens.refreshToken !== undefined) {
          await store.set(key, tokens.refreshToken);
        } else {
          // A sign-in that issued no refresh token must not leave an older one behind.
          await store.remove(key);
        }
        // Only a sign-in that no sign-out followed in the queue re-arms refreshSession.
        if (signOutGeneration(config.clientId) === generation) signedOutClients.delete(config.clientId);
      },
      signal,
    );
    return toSession(tokens);
  } catch (error) {
    await releaseDriver(driver);
    throw error;
  }
}

/** The refreshes queued for each client in this process. Each entry settles when its refresh does. */
const refreshQueues = new Map<string, Promise<void>>();

/**
 * How many times signOut has been called for each client in this process. A refresh records the
 * count when it is called, so a signOut called after that overtakes it.
 */
const signOutGenerations = new Map<string, number>();

/**
 * Clients signed out in this process. signOut adds one, and runSignIn removes it once the new
 * refresh token is stored. refreshSession rejects with SignedOutError for a client in this set.
 */
const signedOutClients = new Set<string>();

function signOutGeneration(clientId: string): number {
  return signOutGenerations.get(clientId) ?? 0;
}

/**
 * Run `work` once every refresh already queued under `queueKey` in this process has
 * settled. A failed refresh does not stall the queue.
 *
 * With `signal`, the returned promise rejects with SignInCancelledError as soon as the signal
 * fires, if `work` has not started yet. The queued `work` still runs when its turn comes, so it
 * must check the signal itself before it writes. Once `work` has started, the promise settles
 * with its outcome.
 */
function queueRefresh<T>(queueKey: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = refreshQueues.get(queueKey) ?? Promise.resolve();
  let started = false;
  const run = previous.then(() => {
    started = true;
    return work();
  });
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  refreshQueues.set(queueKey, settled);
  void settled.then(() => {
    if (refreshQueues.get(queueKey) === settled) refreshQueues.delete(queueKey);
  });
  if (signal === undefined) return run;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      if (!started) reject(new SignInCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    run.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Trade the stored refresh token for a new session. Returns null when nothing is
 * stored, which means the user must sign in again. A token the server refuses with
 * `invalid_grant` is removed from the store, and the error is rethrown. The removal
 * happens only while the store still holds that same token.
 *
 * Rotation: the refresh token returned by the server is written back, whether it is new
 * or unchanged.
 *
 * Concurrency: calls for one client in this process run one after another, so a call
 * reads the token that an earlier call rotated. Across processes that share a store (two
 * app instances, or an app and a helper), this runtime cannot serialize refreshes. A race
 * there can still lose or overwrite a rotated token, and preventing that is the caller's concern.
 *
 * Sign-out: after signOut for the client, this rejects with SignedOutError and sends no request,
 * until runSignIn stores a new token. A signOut called after this call overtakes it: the refresh
 * writes nothing and rejects with SignedOutError, whatever the server answers.
 */
export async function refreshSession(options: RefreshSessionOptions): Promise<SignedInSession | null> {
  const { clientId } = options.config;
  const key = refreshTokenKey(clientId);
  if (signedOutClients.has(clientId)) throw new SignedOutError();
  // Recorded now, not when the queued work starts, so a signOut called in between still overtakes it.
  const generation = signOutGeneration(clientId);
  return queueRefresh(key, () => refreshOnce(options, generation));
}

/** One refresh, run from the queue in refreshSession. `generation` is the sign-out count at the call. */
async function refreshOnce(options: RefreshSessionOptions, generation: number): Promise<SignedInSession | null> {
  const { config, store, fetch, now, timeoutMs } = options;
  const endpoints = resolveEndpoints(config);
  const key = refreshTokenKey(config.clientId);
  // A signOut called after the refresh was requested wins: from then on nothing is read, sent or written.
  const overtaken = (): boolean => signOutGeneration(config.clientId) !== generation;
  if (overtaken()) throw new SignedOutError();

  const current = await store.get(key);
  if (overtaken()) throw new SignedOutError();
  if (current === null) return null;

  let tokens: TokenResponse & { readonly refreshToken: string };
  try {
    tokens = await refreshTokens({
      tokenEndpoint: endpoints.token,
      clientId: config.clientId,
      refreshToken: current,
      fetch,
      now,
      timeoutMs,
    });
  } catch (error) {
    // The signOut that overtook this request queued the removal, so nothing is touched here.
    if (overtaken()) throw new SignedOutError();
    // invalid_grant: the refresh token is revoked, expired or already rotated. Drop the one this call sent,
    // so the next sign-in starts clean. Re-read first: a rotated token that another writer stored since the
    // read above must survive.
    if (error instanceof TokenRequestError && error.oauthError === 'invalid_grant') {
      if ((await store.get(key)) === current) await store.remove(key);
    }
    throw error;
  }

  // A rotated token is dropped, not written back, when a signOut overtook this request.
  if (overtaken()) throw new SignedOutError();
  await store.set(key, tokens.refreshToken);
  return toSession(tokens);
}

/**
 * Forget the stored refresh token on this device. This is local only: it does not
 * revoke the token at Portal, because no revocation endpoint is part of this contract.
 *
 * The mark is set and the stored token is removed when this is called, before any await. A
 * refresh in flight then writes nothing, and refreshSession rejects with SignedOutError until
 * runSignIn stores a new token. So a process killed while this call waits leaves no token behind.
 * The removal is also queued behind the client's refreshes, so it runs after any refresh already
 * in flight and removes the token last, after a refresh that had passed its check has written.
 * This call resolves once both removals have run.
 */
export async function signOut(options: SignOutOptions): Promise<void> {
  const { clientId, store } = options;
  const key = refreshTokenKey(clientId);
  signOutGenerations.set(clientId, signOutGeneration(clientId) + 1);
  signedOutClients.add(clientId);
  const removedNow = store.remove(key);
  const removedLast = queueRefresh(key, () => store.remove(key));
  await Promise.all([removedNow, removedLast]);
}
