/**
 * Start, stop, restart or update every app: the HTTP half.
 *
 * These are the Hub's own sweep routes (`/api/app-lifecycle/*-all`), so the sweep goes through the
 * state machine, grants and status events the dashboard's "Batch actions" use — unlike
 * `cihub app stop-managed`, which stops containers behind the Hub's back and leaves its idea of each
 * app stale. The key is the host-local one the Hub accepts from the box.
 *
 * Split from `cli-app-bulk.ts` the way `hub-claim.ts` is split from `cli-claim.ts`, so the transport
 * is testable without a terminal, a Hub or a process exit.
 */

import { HubUnreachableError, readHubApiKeySource, resolveHubApiBase } from '../public-web-cli.js';
import { HubClaimNoDeviceKey, parseHubClaimError } from './hub-claim.js';

export const BULK_APP_ACTIONS = {
  'start-all': { method: 'POST', route: '/api/app-lifecycle/start-all', requested: 'Start requested for every stopped app.' },
  'stop-all': { method: 'POST', route: '/api/app-lifecycle/stop-all', requested: 'Stop requested for every running app.' },
  'restart-all': { method: 'POST', route: '/api/app-lifecycle/restart-all', requested: 'Restart requested for every running app.' },
  'update-all': { method: 'PATCH', route: '/api/app-lifecycle/update-all', requested: 'Update requested for every app with a newer version.' },
} as const;

export type BulkAppAction = keyof typeof BULK_APP_ACTIONS;

/** How long the Hub gets to accept a sweep before the command stops waiting. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The Hub did not answer in time. Not the same as unreachable: it was listening, and a sweep over many
 * apps may be running right now, so the operator is told to look before asking again.
 */
export class HubBulkRequestTimedOut extends Error {
  constructor(
    readonly base: string,
    readonly seconds: number,
  ) {
    super(`The Hub at ${base} did not answer within ${seconds} seconds.`);
    this.name = 'HubBulkRequestTimedOut';
  }
}

export function isBulkAppAction(value: string): value is BulkAppAction {
  return Object.hasOwn(BULK_APP_ACTIONS, value);
}

/**
 * Ask the Hub to run `action` over all of its apps. Resolves once the Hub has ACCEPTED the request;
 * the apps themselves change state afterwards, and a sweep over many of them takes a while.
 *
 * Throws {@link HubClaimNoDeviceKey} when this machine holds no key, {@link HubUnreachableError} when
 * nothing is listening, {@link HubBulkRequestTimedOut} when the Hub took too long to answer, and a
 * `HubClaimRefused` (the Hub's refusal, with its translation key) when the Hub answered no.
 */
export async function requestBulkAppAction(envFileName: string, action: BulkAppAction): Promise<void> {
  const { method, route } = BULK_APP_ACTIONS[action];
  const base = resolveHubApiBase(envFileName);
  const source = readHubApiKeySource(envFileName);

  // Refused before the request: without the key the Hub answers the same 401 a stranger gets, and
  // reporting that as the Hub's verdict would send the operator after the wrong problem.
  if (!source.key) {
    throw new HubClaimNoDeviceKey(source.checked);
  }

  let response: Response;
  try {
    response = await fetch(`${base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${source.key}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // `AbortSignal.timeout` aborts with a TimeoutError: the Hub was there and was slow, not absent.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new HubBulkRequestTimedOut(base, REQUEST_TIMEOUT_MS / 1000);
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new HubUnreachableError(`Cannot reach the Hub at ${base} — ${detail}`);
  }

  if (!response.ok) {
    throw parseHubClaimError(response.status, await response.text());
  }
}
