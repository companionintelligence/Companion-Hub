import { normalizeHostname } from '@ci-hub/common/types';
import validator from 'validator';
import type { PublicDnsFailure } from '../cloudflare/cloudflare-client.service';

/**
 * The sentence CI-Portal#841 ends a `zone_unreachable` entry with when it moved
 * the app to the environment's own domain instead of refusing it:
 *
 *   "…, so <requested> was not published; the app is served at <served> instead"
 *
 * Read only until CI-Cloud sends `servedHostname` (see {@link readServedHostname}).
 * Anchored at the end and to that exact phrase, so any other wording — and every
 * `zone_unreachable` from a Portal older than #841, which moved nothing and says
 * nothing about where the app is served — matches nothing and moves nothing.
 */
const SERVED_AT_MESSAGE = /; the app is served at (\S+?) instead\.?$/;

/**
 * Where CI-Cloud actually published an app it could not publish on the domain it
 * asked for, or `null` when the entry does not say.
 *
 * Only `zone_unreachable` names such a hostname. Since CI-Portal#841 it is also
 * what CI-Cloud reports when it published the app on its own domain because it
 * cannot write DNS in the requested one — a move, not a refusal: the app IS
 * served, just not where the Hub thinks. Every other reason leaves the app where
 * it was (`release_pending` says so outright), so a hostname on one of those is
 * not a move and is never read as one.
 *
 * The explicit `servedHostname` field wins over the message. The message is a
 * bridge for the Portal as #841 ships it, which carries the hostname nowhere else.
 */
export function readServedHostname(failure: PublicDnsFailure): string | null {
  if (failure.reason !== 'zone_unreachable') {
    return null;
  }

  const raw = failure.servedHostname ?? failure.message?.match(SERVED_AT_MESSAGE)?.[1];

  if (typeof raw !== 'string') {
    return null;
  }

  const hostname = normalizeHostname(raw);

  return validator.isFQDN(hostname, { require_tld: true }) ? hostname : null;
}

/**
 * The public root domain that makes this Hub compose `servedHostname` for the
 * app, or `null` when no root does.
 *
 * The Hub never stores a hostname: every surface — the app's env, its Traefik
 * labels, the Open link, edge auth, the custom-domain join — composes one from
 * the app's public domain. So adopting CI-Cloud's answer means adopting its
 * root, and that is only sound when the Hub's own composition then reproduces
 * the served hostname exactly: the same `<app>-<device>-<org>` prefix on another
 * root. A served name with any other prefix cannot be expressed as a domain
 * choice, and guessing would put the app on a hostname nothing serves.
 *
 * `null` too when the served hostname is the one the Hub already composes, so a
 * repeated notice cannot move anything twice.
 */
export function resolveMovedPublicDomainRoot(params: { servedHostname: string; composedHostname: string; composedRoot: string }): string | null {
  const composed = normalizeHostname(params.composedHostname);
  const composedRoot = normalizeHostname(params.composedRoot);
  const served = normalizeHostname(params.servedHostname);

  if (served === composed || !composed.endsWith(`.${composedRoot}`)) {
    return null;
  }

  const prefix = composed.slice(0, -(composedRoot.length + 1));

  if (!served.startsWith(`${prefix}.`)) {
    return null;
  }

  const servedRoot = served.slice(prefix.length + 1);

  return validator.isFQDN(servedRoot, { require_tld: true }) ? servedRoot : null;
}

/**
 * The saved install form with its public domain moved to `publicDomain`.
 *
 * ⚠ AND EVERY VALUE THAT WAS THE OLD PUBLIC URL, MOVED WITH IT. The install
 * dialog prefills each `app_base_url` field with the app's public URL, and that
 * value is replayed from `app.config` on every start. `generateEnvFile` treats
 * it as automatic — and so moves it — only while it equals the previous
 * `APP_PUBLIC_URL` or the current platform URL. After a domain move that holds
 * for exactly one regeneration: the next one sees the dead URL matching neither,
 * takes it for an operator's pin, and puts `APP_BASE_URL` back on a hostname
 * nothing serves. Only exact matches move (a trailing slash is kept); a value
 * someone typed differs from the prefill and stays as it is.
 */
export function moveStoredPublicDomain(
  config: Record<string, unknown> | null | undefined,
  move: { publicDomain: string; fromUrl: string; toUrl: string },
): Record<string, unknown> {
  const fromUrl = move.fromUrl.replace(/\/+$/, '');
  const moved: Record<string, unknown> = { ...(config ?? {}), publicDomain: move.publicDomain };

  for (const [key, value] of Object.entries(moved)) {
    if (typeof value !== 'string') {
      continue;
    }

    const trailing = value.match(/\/+$/)?.[0] ?? '';

    if (value.slice(0, value.length - trailing.length) === fromUrl) {
      moved[key] = `${move.toUrl.replace(/\/+$/, '')}${trailing}`;
    }
  }

  return moved;
}
