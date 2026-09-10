/**
 * Verify Portal-issued OIDC id_tokens for machine clients (Capture, extension)
 * that hit Traefik forward-auth with `Authorization: Bearer` instead of a Hub
 * session cookie.
 *
 * Browser edge-SSO stays on cookies + tickets. This path is for API clients
 * whose Portal login already produced an id_token (`aud` = client_id, e.g.
 * `ci-applet`) that CI-Server's PortalTokenService also accepts.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { readPortalInternalUrlOverride, resolveOutboundPortalBaseUrl } from '@/common/helpers/portal-url';

/** First-party Portal client audiences that may pass Traefik with a Bearer JWT. */
export const DEFAULT_PORTAL_BEARER_AUDIENCES = ['ci-applet', 'ci-hub', 'ci-browser-extension', 'ci-server', 'ci-import-tools', 'ci-even'] as const;

export type PortalIdTokenClaims = {
  sub: string;
  email: string | null;
  name: string | null;
};

export type PortalTokenVerifyOptions = {
  /** Public Portal origin (`CI_CLOUD_URL`), e.g. https://hub.ci.computer */
  publicCiCloudUrl: string;
  /** Override issuer; default = trimmed public origin (matches CI-Server / Capture id_tokens). */
  issuer?: string;
  /** Override JWKS URL; default = outbound Portal base + `/api/auth/jwks`. */
  jwksUri?: string;
  /** Accepted `aud` values; default = {@link DEFAULT_PORTAL_BEARER_AUDIENCES}. */
  audiences?: string[];
  /** Injected for tests. */
  verify?: typeof jwtVerify;
  /** Injected for tests. */
  createJwks?: typeof createRemoteJWKSet;
};

let cachedJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedJwksUri: string | undefined;

function resolveIssuer(publicCiCloudUrl: string, override?: string): string {
  if (override?.trim()) {
    return override.trim().replace(/\/+$/, '');
  }
  return publicCiCloudUrl.trim().replace(/\/+$/, '');
}

function resolveJwksUri(publicCiCloudUrl: string, override?: string): string {
  if (override?.trim()) {
    return override.trim();
  }
  const outbound = resolveOutboundPortalBaseUrl(publicCiCloudUrl, readPortalInternalUrlOverride()).replace(/\/+$/, '');
  return `${outbound}/api/auth/jwks`;
}

function resolveAudiences(raw?: string[]): string[] {
  if (raw?.length) {
    return raw.map((a) => a.trim()).filter(Boolean);
  }
  const fromEnv = process.env.PORTAL_OIDC_AUDIENCE?.split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  if (fromEnv?.length) {
    return fromEnv;
  }
  return [...DEFAULT_PORTAL_BEARER_AUDIENCES];
}

/**
 * Extract a Bearer token from an Authorization header value.
 * Returns null when the header is missing or not Bearer.
 */
export function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }
  const match = authorization.match(/^Bearer\s+(\S+)/i);
  return match?.[1] ?? null;
}

/**
 * Verify a Portal id_token. Returns claims on success, null when the token is
 * not a valid Portal JWT (wrong iss/aud/sig/exp) so the caller can 401.
 *
 * Never throws for verification failure — callers treat null as reject.
 */
export async function verifyPortalIdToken(token: string, options: PortalTokenVerifyOptions): Promise<PortalIdTokenClaims | null> {
  const publicUrl = options.publicCiCloudUrl?.trim();
  if (!publicUrl) {
    return null;
  }

  const issuer = resolveIssuer(publicUrl, options.issuer ?? process.env.PORTAL_OIDC_ISSUER);
  const jwksUri = resolveJwksUri(publicUrl, options.jwksUri ?? process.env.PORTAL_OIDC_JWKS_URI);
  const audience = resolveAudiences(options.audiences);
  const verify = options.verify ?? jwtVerify;
  const createJwks = options.createJwks ?? createRemoteJWKSet;

  try {
    if (!cachedJwks || cachedJwksUri !== jwksUri) {
      cachedJwks = createJwks(new URL(jwksUri));
      cachedJwksUri = jwksUri;
    }

    const { payload }: { payload: JWTPayload } = await verify(token, cachedJwks, {
      issuer,
      audience,
    });

    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) {
      return null;
    }

    const email = typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim() : null;
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null;

    return { sub, email, name };
  } catch {
    return null;
  }
}

/** Identity string for X-CI-Hub-User — prefer email, then sub. */
export function portalClaimsIdentity(claims: PortalIdTokenClaims): string {
  // Lower-cased for the same reason `ensureLocalCompanionUser` lower-cases before its INSERT: this
  // string is signed into `X-CI-Hub-User`, and the cookie/SSO path signs `user.username`, which is
  // always the lower-cased address. Left raw, `Owner@Example.com` on the Bearer path and
  // `owner@example.com` on the browser path are two different people to every app behind Traefik.
  // `sub` is an opaque Portal id and is passed through as-is. Trimmed as well as folded, because
  // `normalizeUsername` (the fold every `user.username` write goes through) trims too: a claim of
  // `' owner@example.com '` folded but not trimmed is still a different string from the stored
  // username, and would put raw whitespace inside a signed header value.
  const email = claims.email?.trim().toLowerCase();
  return email || claims.sub;
}

/** Test helper — drop cached JWKS between cases. */
export function resetPortalJwksCacheForTests(): void {
  cachedJwks = undefined;
  cachedJwksUri = undefined;
}
