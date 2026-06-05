import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HubEnv } from './cihub-cli';
import { parseEnvFile, resolveRootFolderHost } from './cihub-cli';

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

export function resolveHubApiBase(envFileName: string): string {
  const vars = parseEnvFile(envFileName);
  const port = process.env.API_PORT || vars.API_PORT || '5002';
  return `http://127.0.0.1:${port}`;
}

export function readHubApiKey(envFileName: string): string | undefined {
  const root = resolveRootFolderHost(envFileName);
  const settingsPath = path.join(root, 'state', 'settings.json');
  if (!existsSync(settingsPath)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { ciHubApiKey?: string };
    return settings.ciHubApiKey;
  } catch {
    return undefined;
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

  const response = await fetch(`${base}/api${route}`, { ...init, headers });
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
      return `✓ ${entry.appUrn} → ${entry.repairedHostname}`;
    }
    return `✗ ${entry.appUrn}: ${entry.message || 'repair failed'}`;
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
