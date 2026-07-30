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
