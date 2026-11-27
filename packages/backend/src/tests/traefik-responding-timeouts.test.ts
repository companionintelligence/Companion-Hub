import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

// The shared test setup mocks `fs`; these assertions are ABOUT the real file on disk.
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

/**
 * Traefik's `writeTimeout` and `readTimeout` are the whole time one response may take to send and one
 * request (body included) to arrive, not gaps between writes or reads. At 300s every answer and every
 * upload longer than five minutes was cut where it stood: a Memory export of 11 GB ended at 300.0 s
 * and the browser threw the download away, and an import of it could never have arrived. Every app
 * behind the Hub, on every entry point, shares this file, so both stay unlimited on each.
 */
const REPO_ROOT = path.join(__dirname, '../../../..');
const STATIC_YML = 'packages/backend/assets/traefik/traefik.yml';

/** A Traefik duration in seconds: a bare number is seconds, as Traefik reads it. */
const seconds = (value: unknown): number => {
  const text = String(value).trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text);
  if (!match) throw new Error(`not a Traefik duration: ${text}`);
  const scale = { ms: 0.001, s: 1, m: 60, h: 3600 }[(match[2] ?? 's') as 'ms' | 's' | 'm' | 'h'];
  return Number(match[1]) * scale;
};

describe('traefik entry point responding timeouts', () => {
  const entryPoints = YAML.parse(readFileSync(path.join(REPO_ROOT, STATIC_YML), 'utf-8')).entryPoints as Record<
    string,
    { transport?: { respondingTimeouts?: Record<string, unknown> } }
  >;

  it.each(['web', 'websecure'])('sets no limit on how long %s may take to send a response', (name) => {
    const timeouts = entryPoints[name]?.transport?.respondingTimeouts;

    expect(timeouts).toBeDefined();
    expect(seconds(timeouts?.writeTimeout)).toBe(0);
  });

  it.each(['web', 'websecure'])('sets no limit on how long a request may take to arrive on %s', (name) => {
    expect(seconds(entryPoints[name]?.transport?.respondingTimeouts?.readTimeout)).toBe(0);
  });

  it.each(['web', 'websecure'])('keeps the idle limit between requests on %s', (name) => {
    expect(seconds(entryPoints[name]?.transport?.respondingTimeouts?.idleTimeout)).toBeGreaterThan(0);
  });
});
