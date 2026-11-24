// vendored-from: @companionintelligence/native@0.1.0 packages/native/src/driver.ts
/**
 * Sign-in drivers: the platform half of the authorization-code flow.
 *
 * A driver reserves the redirect target (prepare), opens the authorize URL in the
 * system browser and resolves with the callback URL (start). The driver receives the
 * authorize URL, which carries the state and the S256 challenge. It never receives the
 * PKCE verifier or any token. runSignIn does the rest.
 *
 * prepare() exists because the Tauri loopback redirect carries a port that only the
 * platform knows. The redirect must be reserved before the authorize URL is built.
 */
import { assertSafeRedirectUri } from '@companionintelligence/auth/authorize';

import { SignInCancelledError, SignInError } from './errors.js';
import type { InvokeFn } from './store.js';

/** Where the platform will receive the callback. */
export interface SignInRedirect {
  /** Exact redirect URI to register on the authorize request. */
  readonly redirectUri: string;
  /** Custom scheme the platform listens on, when it has one (Capacitor). Absent for loopback. */
  readonly callbackScheme?: string;
}

export interface SignInStartRequest extends SignInRedirect {
  /** Full authorize URL, already built with the S256 challenge and the state. */
  readonly authorizationUrl: string;
  /** Aborting it cancels the sign-in: the driver releases its listener and rejects. */
  readonly signal?: AbortSignal;
}

export interface SignInDriver {
  /** Reserve the redirect target. Runs before the authorize URL is built. */
  prepare(): Promise<SignInRedirect>;
  /** Open the authorize URL and resolve with the full callback URL. */
  start(request: SignInStartRequest): Promise<string>;
  /** Release anything prepare() reserved. Idempotent. Optional for drivers that reserve nothing. */
  cancel?(): Promise<void>;
}

export type OpenUrl = (url: string) => Promise<void> | void;

/**
 * The contract the native CiAuth Capacitor plugin will implement. It does not exist
 * yet. iOS will use ASWebAuthenticationSession (ephemeral), and Android will use
 * AndroidX Auth Tab. A user cancel rejects with an error whose `code` is `CANCELLED`.
 */
export interface CapacitorAuthPlugin {
  startAuthSession(options: { url: string; callbackScheme: string }): Promise<{ url: string }>;
}

export interface CapacitorSignInDriverOptions {
  readonly plugin: CapacitorAuthPlugin;
  /** Custom-scheme redirect the app registered, such as `cihub://auth/callback`. Not http or https. */
  readonly redirectUri: string;
}

export interface TauriSignInDriverOptions {
  readonly invoke: InvokeFn;
  readonly openUrl: OpenUrl;
  /** How long `await_loopback` waits for the browser to come back. Defaults to 300000 (5 minutes). */
  readonly timeoutMs?: number;
}

const DEFAULT_LOOPBACK_TIMEOUT_MS = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/**
 * Same scheme, host and path. The query and fragment differ on every callback, so they
 * are not compared.
 */
function sameRedirectTarget(callbackUrl: string, redirectUri: string): boolean {
  try {
    const got = new URL(callbackUrl);
    const want = new URL(redirectUri);
    return got.protocol === want.protocol && got.host === want.host && got.pathname === want.pathname;
  } catch {
    return false;
  }
}

/**
 * Settle with `work`, or reject with SignInCancelledError as soon as `signal` aborts.
 * The rejection on abort does not wait for the platform to answer.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new SignInCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new SignInCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
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
 * Driver for iOS and Android through the Capacitor CiAuth plugin. The redirect is a
 * fixed custom scheme that the app registered, so prepare() returns it directly.
 */
export function createCapacitorSignInDriver(options: CapacitorSignInDriverOptions): SignInDriver {
  let parsed: URL;
  try {
    parsed = new URL(options.redirectUri);
  } catch {
    throw new TypeError('redirectUri is not an absolute URI');
  }
  const callbackScheme = parsed.protocol.slice(0, -1);
  if (callbackScheme === 'http' || callbackScheme === 'https') {
    throw new TypeError('the Capacitor redirect must use a custom scheme, such as cihub://auth/callback');
  }
  assertSafeRedirectUri(options.redirectUri, { allowedSchemes: [callbackScheme] });

  const redirect: SignInRedirect = { redirectUri: options.redirectUri, callbackScheme };
  const { plugin } = options;

  return {
    async prepare() {
      return redirect;
    },
    async start({ authorizationUrl, redirectUri, signal }) {
      if (redirectUri !== redirect.redirectUri) {
        throw new SignInError('start() needs the redirect URI that prepare() returned');
      }
      if (signal?.aborted) throw new SignInCancelledError();

      const session = plugin
        .startAuthSession({ url: authorizationUrl, callbackScheme })
        .catch((error: unknown) => {
          if (hasCode(error, 'CANCELLED')) throw new SignInCancelledError();
          throw error;
        });
      // An aborted JS promise cannot close the native sheet, because the plugin contract has no
      // cancel method. The sheet stays open until the user dismisses it.
      const reply = await raceAbort(session, signal);
      const callbackUrl = isRecord(reply) && typeof reply.url === 'string' ? reply.url : undefined;
      if (callbackUrl === undefined) throw new SignInError('startAuthSession did not reply with { url }');
      if (!sameRedirectTarget(callbackUrl, redirectUri)) {
        throw new SignInError('callback URL does not match the redirect URI');
      }
      return callbackUrl;
    },
  };
}

function readLoopbackReply(reply: unknown): { redirectUri: string; port: number } {
  if (!isRecord(reply) || typeof reply.redirectUri !== 'string' || typeof reply.port !== 'number') {
    throw new SignInError('begin_loopback did not reply with { port, redirectUri }');
  }
  return { redirectUri: reply.redirectUri, port: reply.port };
}

/** The loopback redirect must be http on 127.0.0.1 or [::1], on the port the platform reported. */
function requireLoopbackRedirect(redirectUri: string, port: number): void {
  assertSafeRedirectUri(redirectUri, { allowedSchemes: [] });
  const url = new URL(redirectUri);
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]')) {
    throw new SignInError('the loopback redirect must be http on 127.0.0.1 or [::1]');
  }
  const actualPort = url.port === '' ? 80 : Number(url.port);
  if (actualPort !== port) throw new SignInError('begin_loopback port does not match its redirectUri');
}

/**
 * Desktop driver for Tauri, using a loopback redirect on 127.0.0.1 with a port the
 * Rust plugin chooses. Commands: `plugin:ci-auth|begin_loopback` replies with
 * `{ port, redirectUri }`, `await_loopback({ timeoutMs })` replies with `{ url }` (the
 * full callback URL), and `cancel_loopback` releases the listener. A driver is
 * single-use, so create one for each sign-in.
 */
export function createTauriSignInDriver(options: TauriSignInDriverOptions): SignInDriver {
  const { invoke, openUrl } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOOPBACK_TIMEOUT_MS;
  let phase: 'idle' | 'prepared' | 'started' | 'finished' | 'released' = 'idle';
  let reserved: string | undefined;

  /** Release the loopback listener, at most once. Safe after success or failure. */
  async function release(): Promise<void> {
    if (phase !== 'prepared' && phase !== 'started') return;
    phase = 'released';
    await invoke('plugin:ci-auth|cancel_loopback').catch(() => undefined);
  }

  return {
    async prepare() {
      if (phase !== 'idle') {
        throw new SignInError('a Tauri sign-in driver is single-use; create one for each sign-in');
      }
      const reply = await invoke<unknown>('plugin:ci-auth|begin_loopback');
      try {
        const { redirectUri, port } = readLoopbackReply(reply);
        requireLoopbackRedirect(redirectUri, port);
        reserved = redirectUri;
        phase = 'prepared';
        return { redirectUri };
      } catch (error) {
        // The platform may already be listening, so release it before reporting the problem.
        await invoke('plugin:ci-auth|cancel_loopback').catch(() => undefined);
        throw error;
      }
    },
    async start({ authorizationUrl, redirectUri, signal }) {
      if (phase !== 'prepared' || reserved !== redirectUri) {
        throw new SignInError('start() needs the redirect URI that prepare() returned');
      }
      phase = 'started';
      try {
        if (signal?.aborted) throw new SignInCancelledError();
        await openUrl(authorizationUrl);
        const reply = await raceAbort(invoke<unknown>('plugin:ci-auth|await_loopback', { timeoutMs }), signal);
        const callbackUrl = isRecord(reply) && typeof reply.url === 'string' ? reply.url : undefined;
        if (callbackUrl === undefined) throw new SignInError('await_loopback did not reply with { url }');
        if (!sameRedirectTarget(callbackUrl, redirectUri)) {
          throw new SignInError('callback URL does not match the redirect URI');
        }
        phase = 'finished';
        return callbackUrl;
      } catch (error) {
        await release();
        throw error;
      }
    },
    async cancel() {
      await release();
    },
  };
}
