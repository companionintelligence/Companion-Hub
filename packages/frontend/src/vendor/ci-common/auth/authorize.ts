// vendored-from: @companionintelligence/auth@0.0.0 packages/auth/src/authorize.ts
/**
 * Authorization request construction and redirect-URI allowlisting.
 *
 * buildAuthorizeUrl always sends `response_type=code` and
 * `code_challenge_method=S256`. The params type has no field for the method, so a
 * caller cannot choose `plain`, and an implicit or hybrid flow cannot be built.
 *
 * assertSafeRedirectUri is the gate for the redirect target. https is allowed.
 * http is allowed only on 127.0.0.1 or [::1]. A custom scheme is allowed only when
 * the caller lists it. Everything else is rejected, including dangerous schemes
 * such as javascript: and data:, even when someone lists them.
 */
import { CODE_CHALLENGE_METHOD } from './config.js';
import { assertSecureEndpoint, isLoopbackHost, parseAbsoluteUrl } from './internal.js';

/** Schemes that are never a valid OAuth redirect target, whatever the allowlist says. */
const FORBIDDEN_SCHEMES: ReadonlySet<string> = new Set([
  'javascript',
  'data',
  'file',
  'vbscript',
  'blob',
  'about',
  'filesystem',
]);

/** Thrown when a redirect URI fails the allowlist. The message names the rule, not the URI. */
export class UnsafeRedirectUriError extends Error {
  constructor(reason: string) {
    super(`redirect URI rejected: ${reason}`);
    this.name = 'UnsafeRedirectUriError';
  }
}

export interface AuthorizeUrlParams {
  /** Full authorization endpoint, e.g. `${issuer}/api/auth/oauth2/authorize`. */
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  /** Registered redirect URI. Check it with {@link assertSafeRedirectUri} first. */
  readonly redirectUri: string;
  /** Requested scopes, joined with spaces. Must not be empty. */
  readonly scopes: readonly string[];
  /** Value from {@link createStateNonce}. Compared again on the callback. */
  readonly state: string;
  /** Value from {@link createPkcePair}, the S256 challenge. */
  readonly codeChallenge: string;
}

export interface RedirectUriPolicy {
  /** Custom schemes the host app may redirect to, e.g. `['cihub']`. Case and a trailing colon are ignored. */
  readonly allowedSchemes: readonly string[];
}

function normalizeScheme(scheme: string): string {
  return scheme.trim().replace(/:$/, '').toLowerCase();
}

/**
 * Throw {@link UnsafeRedirectUriError} unless the URI is an allowed redirect target.
 * Credentials and fragments are rejected for every scheme, as RFC 6749 section 3.1.2
 * requires for a redirect endpoint.
 */
export function assertSafeRedirectUri(uri: string, policy: RedirectUriPolicy): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new UnsafeRedirectUriError('not an absolute URI');
  }

  const scheme = normalizeScheme(url.protocol);
  if (FORBIDDEN_SCHEMES.has(scheme)) {
    throw new UnsafeRedirectUriError(`scheme "${scheme}" is never allowed`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new UnsafeRedirectUriError('credentials are not allowed in a redirect URI');
  }
  if (url.hash !== '') {
    throw new UnsafeRedirectUriError('fragments are not allowed in a redirect URI');
  }

  if (scheme === 'https') return;
  if (scheme === 'http') {
    if (isLoopbackHost(url.hostname)) return;
    throw new UnsafeRedirectUriError('http is allowed only on 127.0.0.1 or [::1]');
  }
  const allowed = policy.allowedSchemes.map(normalizeScheme);
  if (allowed.includes(scheme)) return;
  throw new UnsafeRedirectUriError(`scheme "${scheme}" is not in allowedSchemes`);
}

/**
 * Build the authorize URL for the authorization-code flow with PKCE.
 * Parameters: response_type, client_id, redirect_uri, scope, state, code_challenge,
 * code_challenge_method. Throws TypeError on an insecure endpoint, a malformed
 * redirect URI or an empty scope list.
 */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const endpoint = assertSecureEndpoint(params.authorizationEndpoint, 'authorizationEndpoint');

  if (params.clientId === '') throw new TypeError('clientId must not be empty');
  if (params.state === '') throw new TypeError('state must not be empty');
  if (params.codeChallenge === '') throw new TypeError('codeChallenge must not be empty');
  if (params.scopes.length === 0) throw new TypeError('scopes must not be empty');
  for (const scope of params.scopes) {
    if (scope === '' || /\s/.test(scope)) throw new TypeError('each scope must be a non-empty token without whitespace');
  }

  // The redirect must parse and must not use a dangerous scheme or plain http off loopback.
  // Passing its own scheme as the allowlist applies the shape checks without requiring a list.
  const redirect = parseAbsoluteUrl(params.redirectUri, 'redirectUri');
  assertSafeRedirectUri(params.redirectUri, { allowedSchemes: [redirect.protocol] });

  const url = new URL(endpoint.href);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', CODE_CHALLENGE_METHOD);
  return url.toString();
}
