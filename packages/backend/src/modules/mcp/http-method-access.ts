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

/** Headers an app may read as "run this request as another method" (`X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override`). */
const METHOD_OVERRIDE_HEADER = /^x-(http-)?method(-override)?$/i;

/** The query parameter an app may read the same way. */
const METHOD_OVERRIDE_PARAM = '_method';

/** A request to an app's own API, as far as deciding what it does goes. */
export interface AppApiRequest {
  method: unknown;
  path?: unknown;
  headers?: unknown;
  queryParams?: unknown;
}

/**
 * True when a request to an app's API only reads: its method, and every method it asks the app to run
 * instead, are all read-only.
 *
 * ⚠ THE METHOD IS NOT THE WHOLE ANSWER. WordPress's REST server, Slim 3, Yii2 and Restler run a GET that
 * carries `X-HTTP-Method-Override: DELETE`, or `?_method=DELETE`, as a DELETE. Judged on its method
 * alone, such a request passed as a read — on `view`, and for a read-only key — and deleted.
 */
export function isReadOnlyHttpRequest(request: AppApiRequest): boolean {
  const methods: unknown[] = [request.method];

  if (request.headers && typeof request.headers === 'object') {
    for (const [name, value] of Object.entries(request.headers)) {
      if (METHOD_OVERRIDE_HEADER.test(name)) {
        methods.push(value);
      }
    }
  }

  if (request.queryParams && typeof request.queryParams === 'object' && Object.hasOwn(request.queryParams, METHOD_OVERRIDE_PARAM)) {
    methods.push((request.queryParams as Record<string, unknown>)[METHOD_OVERRIDE_PARAM]);
  }

  if (typeof request.path === 'string' && request.path.includes('?')) {
    try {
      methods.push(...new URL(request.path, 'http://app.invalid').searchParams.getAll(METHOD_OVERRIDE_PARAM));
    } catch {
      // A path no URL parser accepts says nothing that can be trusted about what it runs.
      methods.push(undefined);
    }
  }

  return methods.every(isReadOnlyHttpMethod);
}

/**
 * The grant a request to an app's own API takes on that app: `view` for a request that only reads, and
 * `configure` for any other — the verbs the app routes assert for reading an app's data and for
 * changing its state. Decided by the same predicate as the capability gates, so a call they count as
 * read-only never needs more than `view`, and one they count as mutating never passes on `view`.
 */
export function appApiAction(request: AppApiRequest): HubAction {
  return isReadOnlyHttpRequest(request) ? 'view' : 'configure';
}
