// vendored-from: @companionintelligence/auth@0.0.0 packages/auth/src/token.ts
/**
 * Token endpoint client for CI-Portal: authorization-code exchange and refresh.
 *
 * This is a public client (PKCE, no secret). The request is form-encoded and never
 * carries `client_secret`. Redirects are refused, so the verifier and the refresh
 * token never reach another host. Every request has a timeout.
 *
 * Errors carry the HTTP status and the OAuth error code, and nothing else. The
 * response body is never copied into an error, so tokens and codes cannot leak
 * through logs.
 */
import { assertSecureEndpoint } from './internal.js';

/** The fetch signature this module needs. Pass a polyfill or a test double through `fetch`. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Tokens from a successful token response. Optional fields are absent, not undefined. */
export interface TokenResponse {
  readonly accessToken: string;
  /** Present when the server issued an id token (the `openid` scope). Not verified here. */
  readonly idToken?: string;
  /** Present when the server issued a refresh token (rotation is possible; see refreshTokens). */
  readonly refreshToken?: string;
  /** Absolute expiry in epoch ms, from `expires_in` and the request start time. */
  readonly expiresAt: number;
  /** Granted scopes, space-delimited, as the server returned them. */
  readonly scope?: string;
}

export interface TokenRequestErrorInit {
  /** HTTP status of the token response, when there was one. */
  readonly status?: number;
  /** OAuth error code from a non-2xx response body, when it was a recognized code. */
  readonly oauthError?: string;
}

/**
 * The token request failed: a network error, a timeout, a redirect, a non-2xx
 * response or a malformed success body. It carries `status` and `oauthError` only.
 */
export class TokenRequestError extends Error {
  readonly status: number | undefined;
  readonly oauthError: string | undefined;

  constructor(message: string, init: TokenRequestErrorInit = {}) {
    super(message);
    this.name = 'TokenRequestError';
    this.status = init.status;
    this.oauthError = init.oauthError;
  }
}

interface TokenRequestCommon {
  /** Token endpoint, e.g. `${issuer}/api/auth/oauth2/token`. Must be https, or http on localhost or loopback. */
  readonly tokenEndpoint: string;
  readonly clientId: string;
  /** Injected fetch. Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Request timeout in ms. Defaults to 15000. Applied with `AbortSignal.timeout`. */
  readonly timeoutMs?: number;
  /** Clock in epoch ms, for `expiresAt`. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface ExchangeOptions extends TokenRequestCommon {
  readonly code: string;
  readonly redirectUri: string;
  /** The PKCE verifier. It is sent here and nowhere else. */
  readonly codeVerifier: string;
}

export interface RefreshOptions extends TokenRequestCommon {
  readonly refreshToken: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const OAUTH_ERROR_PATTERN = /^[a-z_]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Exchange an authorization code for tokens (`grant_type=authorization_code`).
 * `codeVerifier` must be the verifier whose challenge was sent on the authorize request.
 */
export async function exchangeAuthorizationCode(options: ExchangeOptions): Promise<TokenResponse> {
  if (options.code === '') throw new TypeError('code must not be empty');
  if (options.codeVerifier === '') throw new TypeError('codeVerifier must not be empty');
  if (options.redirectUri === '') throw new TypeError('redirectUri must not be empty');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.codeVerifier,
  });
  return postTokenRequest(options, body);
}

/**
 * Refresh the access token (`grant_type=refresh_token`).
 *
 * Refresh tokens may rotate. When the response carries a new `refresh_token`, it
 * replaces the old one. When the response omits `refresh_token`, the old one is still
 * valid and is returned unchanged, so `refreshToken` is always set on the result.
 * Store the returned value, not the one you sent.
 */
export async function refreshTokens(
  options: RefreshOptions,
): Promise<TokenResponse & { readonly refreshToken: string }> {
  if (options.refreshToken === '') throw new TypeError('refreshToken must not be empty');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  });
  const tokens = await postTokenRequest(options, body);
  return { ...tokens, refreshToken: tokens.refreshToken ?? options.refreshToken };
}

async function postTokenRequest(options: TokenRequestCommon, body: URLSearchParams): Promise<TokenResponse> {
  const endpoint = assertSecureEndpoint(options.tokenEndpoint, 'tokenEndpoint');
  if (options.clientId === '') throw new TypeError('clientId must not be empty');

  const now = options.now ?? Date.now;
  const send: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  // Taken before the request, so expiresAt is never later than the server's own clock would allow.
  const requestedAt = now();

  let response: Response;
  try {
    response = await send(endpoint.href, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new TokenRequestError('token request failed before a response arrived');
  }

  if (!response.ok) {
    const oauthError = await readOAuthErrorCode(response);
    throw new TokenRequestError(
      oauthError === undefined
        ? `token endpoint returned HTTP ${response.status}`
        : `token endpoint returned HTTP ${response.status} (${oauthError})`,
      { status: response.status, oauthError },
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new TokenRequestError('token endpoint returned a response that is not JSON', {
      status: response.status,
    });
  }
  return toTokenResponse(json, requestedAt);
}

/**
 * Read the OAuth error code from a non-2xx body. Returns only a recognized code, and
 * discards the body text and anything else in it.
 */
async function readOAuthErrorCode(response: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (isRecord(parsed) && typeof parsed.error === 'string' && OAUTH_ERROR_PATTERN.test(parsed.error)) {
      return parsed.error;
    }
  } catch {
    // Not JSON, or unreadable. Report the status alone.
  }
  return undefined;
}

function toTokenResponse(json: unknown, requestedAt: number): TokenResponse {
  if (!isRecord(json)) {
    throw new TokenRequestError('token response is not a JSON object');
  }
  const { access_token, token_type, expires_in, id_token, refresh_token, scope } = json;
  if (typeof access_token !== 'string' || access_token === '') {
    throw new TokenRequestError('token response has no access_token');
  }
  if (typeof token_type !== 'string' || token_type.toLowerCase() !== 'bearer') {
    throw new TokenRequestError('token response is not a Bearer token');
  }
  // An absent or invalid expires_in counts as zero lifetime, so the caller refreshes
  // rather than trusting a token of unknown age.
  const lifetimeSec = typeof expires_in === 'number' && Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 0;

  return {
    accessToken: access_token,
    expiresAt: requestedAt + lifetimeSec * 1000,
    ...(typeof id_token === 'string' && id_token !== '' ? { idToken: id_token } : {}),
    ...(typeof refresh_token === 'string' && refresh_token !== '' ? { refreshToken: refresh_token } : {}),
    ...(typeof scope === 'string' ? { scope } : {}),
  };
}
