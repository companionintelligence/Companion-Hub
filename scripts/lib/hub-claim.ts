/**
 * Claiming a Hub: the HTTP half.
 *
 * A Hub comes out of `cihub register` with a device key and an organization id and NO operator
 * row — the row was only ever written by an interactive Portal login in a browser. Every
 * operator-authenticated call on such a Hub answered 401 "you must be logged in" while holding a
 * perfectly valid key, and twelve of sixteen fleet nodes sat in that state being diagnosed as key
 * failures. `POST /api/auth/hub/claim` writes the row; this module talks to it.
 *
 * Split from `cli-claim.ts` the way `register-hub.ts` is split from `cli-register.ts`: the
 * transport and the parsing are testable without a terminal, a Hub, or a process exit.
 */

import { HubUnreachableError, readHubApiKeySource, resolveHubApiBase } from '../public-web-cli.js';

export const HUB_CLAIM_ROUTE = '/api/auth/hub/claim';

export type HubClaimStatus = {
  /** At least one operator row exists, so the Hub can answer as somebody. */
  claimed: boolean;
  operators: number;
  /** Paired with Portal: a device registration row and an organization id are both present. */
  registered: boolean;
};

export type HubClaimResult = {
  claimed: boolean;
  username: string;
};

/**
 * A Hub that answered, and refused.
 *
 * `code` is the backend's translation key (`AUTH_ERROR_HUB_ALREADY_CLAIMED`, …) when the body
 * carried one. Callers branch on the key rather than the status or the prose: three different
 * conditions share 409, and the prose is the one part of the answer that is allowed to change.
 */
export class HubClaimRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'HubClaimRefused';
  }
}

/** Raised when this machine holds no device key, which is a fact about the machine, not the Hub. */
export class HubClaimNoDeviceKey extends Error {
  constructor(readonly checked: string[]) {
    super('No Hub device key on this machine.');
    this.name = 'HubClaimNoDeviceKey';
  }
}

/**
 * The translation key and human text out of a Hub error body.
 *
 * `MainExceptionFilter` renders every refusal as `{ statusCode, message, path, intlParams }` where
 * `message` is the translation key. Anything else — an HTML error page from a proxy, an empty body,
 * a truncated read — yields no code, and the caller then reports the status rather than guessing.
 */
export function parseHubClaimError(status: number, body: string): HubClaimRefused {
  let code: string | undefined;
  let message = body.trim().slice(0, 300);

  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && /^[A-Z][A-Z0-9_]*$/.test(parsed.message)) {
      code = parsed.message;
      message = parsed.message;
    } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
      message = parsed.message.trim().slice(0, 300);
    }
  } catch {
    // Not JSON: keep the raw text, which is the most informative thing left.
  }

  return new HubClaimRefused(status, code, message || `Hub claim failed (${status})`);
}

/**
 * A syntactically usable email.
 *
 * Deliberately the same shape check the server's `z.string().email()` makes and nothing more: this
 * exists so a typo fails on the machine the operator is sitting at, not so the CLI can hold an
 * opinion the Hub does not.
 */
export function isValidClaimEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

async function hubClaimRequest(envFileName: string, init: RequestInit): Promise<Response> {
  const base = resolveHubApiBase(envFileName);
  const source = readHubApiKeySource(envFileName);

  // Refused before the request, not after: without the key the Hub answers the same 401 an
  // unauthenticated stranger gets, and reporting that as the Hub's verdict would repeat exactly the
  // misdiagnosis this whole change exists to end.
  if (!source.key) {
    throw new HubClaimNoDeviceKey(source.checked);
  }

  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${source.key}`);

  try {
    return await fetch(`${base}${HUB_CLAIM_ROUTE}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HubUnreachableError(`Cannot reach the Hub at ${base} — ${detail}`);
  }
}

/** Whether this Hub has an operator, and whether it is paired. Requires the host-local device key. */
export async function fetchHubClaimStatus(envFileName: string): Promise<HubClaimStatus> {
  const response = await hubClaimRequest(envFileName, { method: 'GET' });
  if (!response.ok) {
    throw parseHubClaimError(response.status, await response.text());
  }
  return (await response.json()) as HubClaimStatus;
}

/** Create the first operator. Refuses (409) on a Hub that already has one, or is not registered. */
export async function submitHubClaim(envFileName: string, email: string): Promise<HubClaimResult> {
  const response = await hubClaimRequest(envFileName, { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
  if (!response.ok) {
    throw parseHubClaimError(response.status, await response.text());
  }
  return (await response.json()) as HubClaimResult;
}
