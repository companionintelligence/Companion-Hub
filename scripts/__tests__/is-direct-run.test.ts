import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDirectScriptRun } from '../lib/is-direct-run';

describe('isDirectScriptRun', () => {
  it('returns true when the module is the Bun entrypoint', () => {
    const modulePath = fileURLToPath(new URL('../sync-postgres-password.ts', import.meta.url));
    expect(isDirectScriptRun(modulePath, true)).toBe(true);
  });

  it('returns false when the module is imported by the bundled CLI', () => {
    const modulePath = fileURLToPath(new URL('../sync-postgres-password.ts', import.meta.url));
    expect(isDirectScriptRun(modulePath, false)).toBe(false);
  });

  it('returns true when argv matches the module path (tsx direct execution)', () => {
    const modulePath = fileURLToPath(new URL('../sync-postgres-password.ts', import.meta.url));
    const originalArgv = process.argv.slice();

    try {
      process.argv[1] = modulePath;
      expect(isDirectScriptRun(modulePath, undefined)).toBe(true);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('returns false when argv points at a different entrypoint', () => {
    const modulePath = fileURLToPath(new URL('../sync-postgres-password.ts', import.meta.url));
    const originalArgv = process.argv.slice();

    try {
      process.argv[1] = path.resolve('/tmp/cihub');
      expect(isDirectScriptRun(modulePath, undefined)).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });
});
