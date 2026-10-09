export const CI_MARKETPLACE_STORE_SLUG = 'ci-marketplace';

/**
 * Ceiling for fetching Portal's full `/store` listing, for the in-memory catalog and the CI Marketplace
 * sync alike. Portal builds that listing on demand and has taken 16–37s, so the 30s and 15s client
 * defaults failed every time and neither copy of the catalog refreshed.
 */
export const PORTAL_STORE_LISTING_TIMEOUT_MS = 45_000;

/**
 * Why a Portal request made on behalf of an app operation got no usable answer. Carried as the
 * `errorCode` of a failed `downloadAppFiles` result so the lifecycle service, the SSE payload and
 * the Sentry classifier all see the same cause instead of re-deriving it from message text.
 *
 * - `portal_timeout`: the request was sent and nothing came back inside the client timeout.
 * - `portal_unreachable`: the socket never carried a request — DNS, refused, no route.
 * - `portal_http_error`: Portal answered, with a status the Hub has no specific handling for.
 *
 * The first two are the device's network or a starved host, and are reported as warnings grouped
 * together. The last is Portal's, and stays an error.
 */
export const PORTAL_TIMEOUT_CODE = 'portal_timeout';
export const PORTAL_UNREACHABLE_CODE = 'portal_unreachable';
export const PORTAL_HTTP_ERROR_CODE = 'portal_http_error';

export type PortalRequestErrorCode = typeof PORTAL_TIMEOUT_CODE | typeof PORTAL_UNREACHABLE_CODE | typeof PORTAL_HTTP_ERROR_CODE;

/**
 * Whether an axios error is the client's own `timeout` elapsing — reported as `ECONNABORTED` —
 * or a connection that never formed. A connect that ran out of time at the socket arrives as
 * `ETIMEDOUT` on the attempt and is the second kind: no request was ever sent.
 */
export function portalErrorCodeFor(error: { code?: unknown }): PortalRequestErrorCode {
  return error.code === 'ECONNABORTED' ? PORTAL_TIMEOUT_CODE : PORTAL_UNREACHABLE_CODE;
}
