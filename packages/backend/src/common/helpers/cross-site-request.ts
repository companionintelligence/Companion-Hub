import type { NextFunction, Request, Response } from 'express';
import { resolveAllowedCorsOrigin } from './cors-origin';

/**
 * Refuse a state-changing request another site's page made a browser send.
 *
 * CORS stops a foreign page from READING the Hub's answers, not from SENDING a request: a plain
 * `<form method="post">` or a no-cors `fetch` needs no preflight, and the Hub parses urlencoded
 * bodies. So a page anywhere could pair an unpaired Hub to the attacker's Portal organisation
 * (`/registration/pair` is unauthenticated by design), and an app the operator opened
 * at `<hub host>:<its port>` counts as the same SITE, which `SameSite=Lax` lets through.
 *
 * The rule, for anything but GET/HEAD/OPTIONS:
 * - A request that carries its own credential (`Authorization`, `X-API-Key`, `X-CI-Hub-Session`) is
 *   not one a foreign page can forge — it would need the secret — and a custom header already forces
 *   a CORS preflight. Left alone, so a CLI, an app callback or a pool peer is unaffected.
 * - Otherwise the browser's Fetch Metadata decides: `same-origin` (the Hub page) and `none` (typed
 *   or bookmarked) pass; `same-site` and `cross-site` are refused unless the page's Origin is one the
 *   Hub already trusts with credentials (`resolveAllowedCorsOrigin`: the Tauri shells, the Hub's own
 *   names). An older browser without Fetch Metadata is judged by Origin against the request's host.
 * - Neither header at all is a request no browser made, and is left alone.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function carriesOwnCredential(req: Request): boolean {
  return Boolean(req.get('authorization') || req.get('x-api-key') || req.get('x-ci-hub-session'));
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim() || undefined;
}

/** Whether `origin` names the host this request was sent to. Only for a browser's own Origin header. */
function isSameOriginAsRequest(origin: string, req: Request): boolean {
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const requestHost = (firstHeaderValue(req.get('x-forwarded-host')) ?? req.get('host') ?? '').toLowerCase();
  return Boolean(requestHost) && originHost === requestHost;
}

export function isRefusedCrossSiteRequest(req: Request): boolean {
  if (SAFE_METHODS.has(req.method) || carriesOwnCredential(req)) {
    return false;
  }

  const site = req.get('sec-fetch-site')?.trim().toLowerCase();
  const origin = req.get('origin')?.trim();

  if (!site && !origin) {
    return false;
  }
  if (site === 'same-origin' || site === 'none') {
    return false;
  }

  const trustedOrigin = Boolean(origin) && origin !== 'null' && resolveAllowedCorsOrigin(origin) === origin;
  if (trustedOrigin) {
    return false;
  }
  // No Fetch Metadata (an older browser): fall back to comparing Origin with the request's host.
  if (!site && origin && origin !== 'null') {
    return !isSameOriginAsRequest(origin, req);
  }
  return true;
}

export function crossSiteRequestGuard(req: Request, res: Response, next: NextFunction): void {
  if (isRefusedCrossSiteRequest(req)) {
    res.status(403).json({ statusCode: 403, message: 'Cross-site request refused' });
    return;
  }
  next();
}
