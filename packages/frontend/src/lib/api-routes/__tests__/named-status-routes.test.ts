import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { NAMED_STATUS_ROUTES } from '../named-status-routes';

/**
 * Reads the generated SDK as text on purpose. The point of this test is to catch a
 * REGENERATION that renumbers `getStatusN`, and an assertion routed through the
 * imported function would be testing the same generated artefact through a layer
 * that cannot see which URL it holds. The file is generated, so its shape is stable
 * enough to match, and a match failure is itself the signal that the generator changed.
 */
const SDK = resolve(dirname(fileURLToPath(import.meta.url)), '../../../api-client/sdk.gen.ts');

function urlOf(operation: string): string | null {
  const source = readFileSync(SDK, 'utf-8');
  // `export const getStatus3 = <...>(...) => (...).get<...>({ url: '/api/tailscale/status', ... })`
  const match = new RegExp(`export const ${operation}\\s*=[\\s\\S]*?url:\\s*'([^']+)'`).exec(source);

  return match?.[1] ?? null;
}

describe('named status routes', () => {
  it.each(Object.entries(NAMED_STATUS_ROUTES))('%s still points at %s', (operation, expected) => {
    expect(urlOf(operation)).toBe(expected);
  });

  it('names every generated getStatusN, so a new one cannot slip in unnamed', () => {
    const source = readFileSync(SDK, 'utf-8');
    const generated = [...source.matchAll(/export const (getStatus\d*)\s*=/g)].map((match) => match[1]).sort();

    expect(generated).toEqual(Object.keys(NAMED_STATUS_ROUTES).sort());
  });
});
