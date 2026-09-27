import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDirectScriptRun } from '../lib/is-direct-run';

const scriptsDir = path.resolve(import.meta.dirname, '..');

function withArgv1<T>(entry: string, body: () => T): T {
  const originalArgv = process.argv.slice();
  try {
    process.argv[1] = entry;
    return body();
  } finally {
    process.argv = originalArgv;
  }
}

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
    expect(withArgv1(modulePath, () => isDirectScriptRun(modulePath, undefined))).toBe(true);
  });

  it('returns false when argv points at a different entrypoint', () => {
    const modulePath = fileURLToPath(new URL('../sync-postgres-password.ts', import.meta.url));
    expect(withArgv1(path.resolve('/tmp/cihub'), () => isDirectScriptRun(modulePath, undefined))).toBe(false);
  });

  /**
   * What the compiled `cihub` sees: Bun bundles every module into the binary, so each one's
   * import.meta.url is the binary's own `file:///$bunfs/root/<name>` and argv[1] is that same path.
   * Comparing the two says "entrypoint" for every bundled module at once, which is how
   * sync-rabbitmq-password's entry block ran on every command, `cihub --version` included.
   */
  it('returns false for a module inside a Bun standalone binary, where argv[1] is the binary itself', () => {
    const moduleUrl = 'file:///$bunfs/root/cihub-linux-x64';
    expect(withArgv1('/$bunfs/root/cihub-linux-x64', () => isDirectScriptRun(moduleUrl, undefined))).toBe(false);
  });

  it('returns false for the Windows form of the Bun standalone filesystem', () => {
    const moduleUrl = 'file:///B:/~BUN/root/cihub-windows-x64.exe';
    // argv[1] is built from the URL so the two compare equal on any host OS, as they do on Windows.
    expect(withArgv1(fileURLToPath(moduleUrl), () => isDirectScriptRun(moduleUrl, undefined))).toBe(false);
  });

  it('still honours an explicit import.meta.main inside a Bun standalone binary', () => {
    expect(isDirectScriptRun('file:///$bunfs/root/cihub-linux-x64', true)).toBe(true);
  });
});

/**
 * Bun rewrites `import.meta.main` to a literal `false` in every module it bundles, and that literal
 * is what keeps an entry block from running inside the compiled CLI. It only helps where the call
 * actually passes it. A call that omits it still compiles, because root `scripts/` is outside
 * `pnpm run tsc` and nothing reports the missing argument, so this reads the call sites instead.
 */
describe('isDirectScriptRun call sites', () => {
  const callSites = fs
    .readdirSync(scriptsDir, { recursive: true, encoding: 'utf-8' })
    .filter((file) => /\.[cm]?[jt]s$/.test(file))
    .filter((file) => !file.split(path.sep).some((segment) => segment === '__tests__' || segment === 'node_modules'))
    .filter((file) => file !== path.join('lib', 'is-direct-run.ts'))
    .flatMap((file) => {
      const source = fs.readFileSync(path.join(scriptsDir, file), 'utf-8');
      return [...source.matchAll(/isDirectScriptRun\(([^)]*)\)/g)].map((match) => ({
        site: `scripts/${file.split(path.sep).join('/')}:${source.slice(0, match.index).split('\n').length}`,
        args: match[1].replace(/\s+/g, ' ').trim(),
      }));
    });

  it('finds the known callers, so an empty scan cannot pass', () => {
    const sites = callSites.map(({ site }) => site.replace(/:\d+$/, ''));
    expect(sites).toEqual(expect.arrayContaining(['scripts/sync-postgres-password.ts', 'scripts/sync-rabbitmq-password.ts']));
  });

  it('passes import.meta.main at every call site', () => {
    const missing = callSites.filter(({ args }) => args !== 'import.meta.url, import.meta.main').map(({ site, args }) => `${site}: (${args})`);
    expect(missing).toEqual([]);
  });
});
