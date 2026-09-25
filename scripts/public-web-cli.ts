import { existsSync, readFileSync } from 'node:fs';
import type { HubEnv } from './cihub-cli';
import { parseEnvFile } from './env-file';
import { BASE_COMMAND } from './lib/cli-types';
import { resolveSettingsCandidates } from './lib/paths';

export interface PublicWebDiagnosticEntry {
  appUrn: string;
  appName: string;
  status: string;
  dbPublicDomain: string | null;
  computedHostname: string;
  computedPublicUrl: string;
  envHostname: string | null;
  envMismatch: boolean;
  action: 'ok' | 'repair';
}

export interface PublicWebDiagnosticsResponse {
  apps: PublicWebDiagnosticEntry[];
  mismatchCount: number;
}

export interface PublicWebRepairResponse {
  results: { appUrn: string; success: boolean; message?: string; repairedHostname?: string }[];
  synced: boolean;
}

/** Prefixes for repair result lines (exported for CLI tone detection and tests). */
export const PUBLIC_WEB_REPAIR_OK_PREFIX = '\u2713';
export const PUBLIC_WEB_REPAIR_FAIL_PREFIX = '\u2717';

export function publicWebRepairHasFailures(lines: string[]): boolean {
  return lines.some((line) => line.startsWith(PUBLIC_WEB_REPAIR_FAIL_PREFIX));
}

export function resolveHubApiBase(envFileName: string): string {
  const vars = parseEnvFile(envFileName);
  const port = vars.API_PORT || '5002';
  return `http://127.0.0.1:${port}`;
}

/**
 * The device key, and which file it came from.
 *
 * `checked` is every path that was read and did not yield a key. Callers report it instead
 * of asserting the Hub is unpaired: not finding a key in the places we looked is a fact
 * about the search, and the two are not the same finding. See `resolveSettingsCandidates`.
 */
export function readHubApiKeySource(envFileName: string): { key?: string; found?: string; checked: string[] } {
  const checked: string[] = [];
  for (const settingsPath of resolveSettingsCandidates(envFileName)) {
    if (!existsSync(settingsPath)) {
      checked.push(settingsPath);
      continue;
    }
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { hubLocalKey?: string; ciHubApiKey?: string };
      // The host-local key is what the Hub accepts from the box (AuthMiddleware `host-local`). The
      // Portal device key is the fallback for a Hub that has not booted on a build that mints one
      // yet; once Portal confirms the push key, the Hub stops accepting it and only the local key does.
      const key = settings.hubLocalKey || settings.ciHubApiKey;
      if (key) return { key, found: settingsPath, checked };
    } catch {
      // Unreadable or malformed: it decided nothing, so keep looking and report it as checked.
    }
    checked.push(settingsPath);
  }
  return { checked };
}

export function readHubApiKey(envFileName: string): string | undefined {
  return readHubApiKeySource(envFileName).key;
}

/**
 * The Hub is not answering on its local port. Its own error class so a caller can
 * tell "the Hub is not running" from "the Hub said no", which need different
 * advice: start it, versus look at what it refused.
 */
export class HubUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubUnreachableError';
  }
}

export async function hubApiFetch<T>(envFileName: string, route: string, init: RequestInit = {}): Promise<T> {
  const base = resolveHubApiBase(envFileName);
  const apiKey = readHubApiKey(envFileName);
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (apiKey) {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }

  let response: Response;

  try {
    response = await fetch(`${base}/api${route}`, { ...init, headers });
  } catch (error) {
    /*
     * A refused connection here means the Hub is not listening, which is an
     * ordinary state on a machine where it was never started — not an exception
     * worth a stack trace. Left unhandled this escapes `fetch` as a raw
     * TypeError and the operator gets bundled source dumped at them: observed on
     * a fleet node running `cihub pool status` with no Hub up.
     */
    const detail = error instanceof Error ? error.message : String(error);

    throw new HubUnreachableError(`Cannot reach the Hub at ${base} — ${detail}\nIs it running? Check with: ${BASE_COMMAND} status`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Hub API ${route} failed (${response.status}): ${text || response.statusText}`);
  }
  return (await response.json()) as T;
}

export function formatPublicWebStatusTable(diagnostics: PublicWebDiagnosticsResponse): string[] {
  if (diagnostics.apps.length === 0) {
    return ['No cloudflare-exposed apps found.'];
  }

  const lines = [
    `${'APP'.padEnd(18)} ${'DB DOMAIN'.padEnd(22)} ${'COMPUTED URL'.padEnd(40)} ENV MATCH  ACTION`,
    `${'-'.repeat(18)} ${'-'.repeat(22)} ${'-'.repeat(40)} ${'-'.repeat(9)} ${'-'.repeat(6)}`,
  ];

  for (const app of diagnostics.apps) {
    const match = app.envMismatch ? 'mismatch' : 'ok';
    const action = app.action;
    lines.push(
      `${app.appName.padEnd(18)} ${(app.dbPublicDomain || '-').padEnd(22)} ${app.computedPublicUrl.padEnd(40)} ${match.padEnd(9)} ${action}`,
    );
  }

  if (diagnostics.mismatchCount > 0) {
    lines.push('');
    lines.push(`${diagnostics.mismatchCount} app(s) need repair — run: cihub public-web repair`);
  }

  return lines;
}

export async function runPublicWebStatus(envFileName: string): Promise<string[]> {
  const diagnostics = await hubApiFetch<PublicWebDiagnosticsResponse>(envFileName, '/public-web/diagnostics');
  return formatPublicWebStatusTable(diagnostics);
}

export async function runPublicWebRepair(envFileName: string, appName?: string): Promise<string[]> {
  const body: { appUrns?: string[] } = {};
  if (appName) {
    const diagnostics = await hubApiFetch<PublicWebDiagnosticsResponse>(envFileName, '/public-web/diagnostics');
    const match = diagnostics.apps.find((app) => app.appName === appName || app.appUrn.startsWith(`${appName}:`));
    if (!match) {
      return [`No cloudflare-exposed app matching "${appName}".`];
    }
    body.appUrns = [match.appUrn];
  }

  const result = await hubApiFetch<PublicWebRepairResponse>(envFileName, '/public-web/repair', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const lines = result.results.map((entry) => {
    if (entry.success) {
      return `${PUBLIC_WEB_REPAIR_OK_PREFIX} ${entry.appUrn} \u2192 ${entry.repairedHostname}`;
    }
    return `${PUBLIC_WEB_REPAIR_FAIL_PREFIX} ${entry.appUrn}: ${entry.message || 'repair failed'}`;
  });

  if (lines.length === 0) {
    lines.push('No mismatched apps to repair.');
  }

  if (result.synced) {
    lines.push('Cloudflare sync triggered.');
  }

  return lines;
}

export function resolvePublicWebEnv(env?: string): HubEnv {
  return (env || 'dev') as HubEnv;
}
