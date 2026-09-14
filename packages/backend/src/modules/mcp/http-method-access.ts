import type { HubAction } from '@/core/portal/hub-actions';

/**
 * Which HTTP verbs only read — the single list behind every verb-derived capability decision.
 *
 * Two paths classify a proxied call: `hub_call_app_api`, which decides per call from its `method`
 * argument, and the OpenAPI bridge, which decides once per generated tool from its operation's verb.
 * They were separate literals and had already drifted (the bridge counted OPTIONS as reading, the
 * proxy did not), so a read-only key reached a verb through one path that the other refused. One
 * exported list means the two cannot disagree about the same verb again.
 *
 * OPTIONS is here because HTTP defines it as safe (RFC 9110 §9.2.1): it describes what an endpoint
 * accepts and changes nothing. The proxy's own input schema does not offer OPTIONS, so including it
 * widens nothing there — it only stops the bridge and the proxy contradicting each other.
 */
export const READ_ONLY_HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;

/**
 * True when this verb only reads. Unrecognised or absent verbs count as mutating: callers reach here
 * with unvalidated arguments, and the safe reading of "we do not know what this does" is the one that
 * grants least.
 */
export function isReadOnlyHttpMethod(method: unknown): boolean {
  return (READ_ONLY_HTTP_METHODS as readonly string[]).includes(String(method ?? '').toUpperCase());
}

/**
 * The grant a request to an app's own API takes on that app: `view` for a verb that only reads, and
 * `configure` for any other — the verbs the app routes assert for reading an app's data and for
 * changing its state. Decided from the same list as the capability gates, so a call they count as
 * read-only never needs more than `view`, and one they count as mutating never passes on `view`.
 */
export function appApiAction(method: unknown): HubAction {
  return isReadOnlyHttpMethod(method) ? 'view' : 'configure';
}
