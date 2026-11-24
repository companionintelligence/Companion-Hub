// vendored-from: @companionintelligence/auth@0.0.0 packages/auth/src/config.ts
/**
 * OIDC client configuration for talking to CI-Portal as the identity provider.
 *
 * CI-Portal (better-auth `oidcProvider`) is the org IdP. Its endpoints live under
 * `/api/auth/oauth2/*` and discovery is published at `/.well-known/openid-configuration`.
 * Grounded in:
 *   - CI-Portal  apps/hono-app/src/lib/auth/services/createAuth.ts (oidcProvider, cookiePrefix 'ci')
 *   - CI-Server  backend/apps/api/src/domains/auth/controllers/OidcController.ts (authorize params)
 *   - CI-Server  backend/apps/api/src/configuration.ts (auth.portal: issuer/jwksUri/audience)
 *   - CI-Hub     packages/backend/src/modules/auth/portal-sso.ts (token/userinfo/get-session)
 */

/** First-party PKCE clients registered in Portal's `PUBLIC_CLIENTS`. */
export type CiOidcClientId = 'ci-server' | 'ci-hub' | (string & {});

/** OIDC scopes. The whole platform uses the fixed set `openid email profile`. */
export type OidcScope = 'openid' | 'email' | 'profile' | (string & {});

export interface OidcEndpoints {
  /** OIDC discovery document. Shape: `${issuerUrl}/.well-known/openid-configuration`. */
  readonly discovery: string;
  /** Authorization endpoint. Shape: `${issuerUrl}/api/auth/oauth2/authorize`. */
  readonly authorization: string;
  /** Token endpoint. Shape: `${issuerUrl}/api/auth/oauth2/token`. */
  readonly token: string;
  /** UserInfo endpoint. Shape: `${issuerUrl}/api/auth/oauth2/userinfo`. */
  readonly userinfo: string;
  /** JWKS URI used to verify Portal-signed id/access tokens (EdDSA). */
  readonly jwks: string;
  /**
   * Better-auth session endpoint. Not part of OIDC proper, but CI-Hub reads it
   * (`/api/auth/get-session`) to resolve the signed-in Portal email server-side.
   */
  readonly session: string;
}

export interface OidcConfig {
  /**
   * Portal origin, e.g. `https://portal.companionintelligence.com` in prod or
   * `http://localhost:8787` in dev. No trailing slash — normalized by
   * {@link deriveEndpoints}.
   */
  readonly issuerUrl: string;
  /**
   * Expected `iss` claim on Portal-issued JWTs. Usually equals `issuerUrl`, but
   * kept separate because Portal may issue with a canonical issuer that differs
   * from the reachable origin (internal-URL override, see portal-url helpers).
   */
  readonly issuer: string;
  /** This app's registered client_id (e.g. `ci-server`, `ci-hub`). */
  readonly clientId: CiOidcClientId;
  /**
   * Accepted token audiences. Portal issues per-client tokens where
   * `aud === client_id`, so this is typically `[clientId]`. Config env
   * `PORTAL_OIDC_AUDIENCE` is comma-separated; parse with {@link parseAudience}.
   */
  readonly audience: readonly string[];
  /** OAuth redirect_uri (this app's callback). Must be a Portal-allowed URI. */
  readonly redirectUri: string;
  /** Requested scopes. Defaults to `['openid', 'email', 'profile']`. */
  readonly scopes: readonly OidcScope[];
  /**
   * Client-side storage key namespace for the persisted session, following the
   * dotted convention used across the workspace (cf. `ci-hub.portalAccountEmail`,
   * cookiePrefix `ci`). The session blob is stored under `${storageKey}.session`.
   */
  readonly storageKey: string;
  /** Derived endpoint URLs. Prefer {@link deriveEndpoints} over hand-building. */
  readonly endpoints: OidcEndpoints;
}

/** Default requested scopes — matches CI-Server's `authorize` call exactly. */
export const DEFAULT_OIDC_SCOPES: readonly OidcScope[] = ['openid', 'email', 'profile'];

/** PKCE code-challenge method used platform-wide. */
export const CODE_CHALLENGE_METHOD = 'S256' as const;

/** Strip trailing slashes so endpoint concatenation is stable. */
function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

/**
 * Build the OIDC endpoint set from a Portal origin. Endpoint shapes are fixed by
 * Portal's better-auth mount point (`/api/auth`), so consumers should never
 * hard-code these paths.
 */
export function deriveEndpoints(issuerUrl: string): OidcEndpoints {
  const base = normalizeOrigin(issuerUrl);

  return {
    discovery: `${base}/.well-known/openid-configuration`,
    authorization: `${base}/api/auth/oauth2/authorize`,
    token: `${base}/api/auth/oauth2/token`,
    userinfo: `${base}/api/auth/oauth2/userinfo`,
    jwks: `${base}/api/auth/jwks`,
    session: `${base}/api/auth/get-session`,
  };
}

/** Parse the comma-separated `PORTAL_OIDC_AUDIENCE` env into a trimmed list. */
export function parseAudience(raw: string): string[] {
  return raw
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

export interface DefaultCiOidcConfigInput {
  /** Portal origin. Placeholder in dev: `http://localhost:8787`. */
  issuerUrl?: string;
  clientId: CiOidcClientId;
  /** This app's OIDC callback URL. */
  redirectUri: string;
  /** Override audiences; defaults to `[clientId]`. */
  audience?: readonly string[];
  /** Override issuer; defaults to `issuerUrl`. */
  issuer?: string;
  /** Override scopes; defaults to {@link DEFAULT_OIDC_SCOPES}. */
  scopes?: readonly OidcScope[];
  /** Override storage-key namespace; defaults to `ci.<clientId>`. */
  storageKey?: string;
}

/**
 * Produce a ready-to-use {@link OidcConfig} with CI conventions applied.
 *
 * NOTE: `issuerUrl` defaults to a dev placeholder. In every real deployment this
 * MUST be supplied from configuration (CI-Server `OIDC_ISSUER_URL` /
 * `PORTAL_OIDC_ISSUER`, CI-Hub `PORTAL_BASE_URL`).
 */
export function defaultCiOidcConfig(input: DefaultCiOidcConfigInput): OidcConfig {
  // TODO(framing): source from env in the host app; placeholder for the skeleton.
  const issuerUrl = normalizeOrigin(input.issuerUrl ?? 'http://localhost:8787');

  return {
    issuerUrl,
    issuer: input.issuer ?? issuerUrl,
    clientId: input.clientId,
    audience: input.audience ?? [input.clientId],
    redirectUri: input.redirectUri,
    scopes: input.scopes ?? DEFAULT_OIDC_SCOPES,
    storageKey: input.storageKey ?? `ci.${input.clientId}`,
    endpoints: deriveEndpoints(issuerUrl),
  };
}
