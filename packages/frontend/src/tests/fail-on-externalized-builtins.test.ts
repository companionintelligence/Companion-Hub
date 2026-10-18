import { describe, expect, it } from 'vitest';
import {
  ALLOWED_EXTERNALIZED_BUILTINS,
  assertNoExternalizedBuiltin,
  type ExternalizedBuiltinException,
  failOnExternalizedBuiltins,
} from '../../vite-plugins/fail-on-externalized-builtins';

/**
 * The message Vite 8 (Rolldown) logged for #2037, `better-ajv-errors` 3.x importing `node:util`, with the `[plugin ...]`
 * prefix Vite adds when it prints the log left off (a plugin's `onLog` sees the raw message).
 */
const importer = '/app/node_modules/.pnpm/better-ajv-errors@3.0.2_ajv@8.20.0/node_modules/better-ajv-errors/dist/index.mjs';
const externalized = (specifier: string, from = importer) =>
  `Module "${specifier}" has been externalized for browser compatibility, imported by "${from}". See https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.`;

describe('assertNoExternalizedBuiltin', () => {
  it('throws for a node: builtin and names the specifier, the importer and how to allow it', () => {
    expect(() => assertNoExternalizedBuiltin({ plugin: 'rolldown:vite-resolve', message: externalized('node:util') })).toThrow(
      /Node builtin "node:util" is imported by browser code in ".*better-ajv-errors\/dist\/index\.mjs"/,
    );
    expect(() => assertNoExternalizedBuiltin({ message: externalized('node:util') })).toThrow(/ALLOWED_EXTERNALIZED_BUILTINS/);
  });

  it('throws for a bare builtin specifier, a subpath builtin and a plain string log', () => {
    expect(() => assertNoExternalizedBuiltin({ message: externalized('util') })).toThrow(/"util"/);
    expect(() => assertNoExternalizedBuiltin({ message: externalized('fs/promises') })).toThrow(/"fs\/promises"/);
    expect(() => assertNoExternalizedBuiltin(externalized('node:path'))).toThrow(/"node:path"/);
  });

  it('throws on the marker in an unrecognised shape instead of silently passing', () => {
    expect(() => assertNoExternalizedBuiltin({ message: 'something has been externalized for browser compatibility' })).toThrow(
      /shape this guard does not recognise/,
    );
  });

  it('passes unrelated warnings and non-log values', () => {
    expect(() =>
      assertNoExternalizedBuiltin({
        message: 'src/lib/api-fetch.ts is dynamically imported by src/lib/mobile-connection.ts but also statically imported elsewhere',
        code: 'INEFFECTIVE_DYNAMIC_IMPORT',
      }),
    ).not.toThrow();
    expect(() => assertNoExternalizedBuiltin('Some chunks are larger than 500 kB after minification')).not.toThrow();
    expect(() => assertNoExternalizedBuiltin({})).not.toThrow();
    expect(() => assertNoExternalizedBuiltin(undefined)).not.toThrow();
    expect(() => assertNoExternalizedBuiltin({ message: 42 })).not.toThrow();
  });

  it('passes the same warning for a module that is not a Node builtin (a package browser-field mapping)', () => {
    expect(() => assertNoExternalizedBuiltin({ message: externalized('./lib/server-only.js') })).not.toThrow();
    expect(() => assertNoExternalizedBuiltin({ message: externalized('some-optional-peer') })).not.toThrow();
  });

  it('passes an allow-listed builtin for the allow-listed importer, with or without the node: prefix', () => {
    const allowed: ExternalizedBuiltinException[] = [{ specifier: 'node:util', importer: '/node_modules/better-ajv-errors/', reason: 'test' }];
    expect(() => assertNoExternalizedBuiltin({ message: externalized('node:util') }, allowed)).not.toThrow();
    expect(() => assertNoExternalizedBuiltin({ message: externalized('util') }, allowed)).not.toThrow();
    expect(() => assertNoExternalizedBuiltin({ message: externalized('node:util', importer.replaceAll('/', '\\')) }, allowed)).not.toThrow();
  });

  it('keeps the exception narrow: another importer or another builtin still throws', () => {
    const allowed: ExternalizedBuiltinException[] = [{ specifier: 'node:util', importer: '/node_modules/better-ajv-errors/', reason: 'test' }];
    expect(() => assertNoExternalizedBuiltin({ message: externalized('node:util', '/app/node_modules/other-pkg/index.js') }, allowed)).toThrow(
      /other-pkg/,
    );
    expect(() => assertNoExternalizedBuiltin({ message: externalized('node:fs') }, allowed)).toThrow(/"node:fs"/);
  });

  it('ships with no exceptions', () => {
    expect(ALLOWED_EXTERNALIZED_BUILTINS).toEqual([]);
  });
});

describe('failOnExternalizedBuiltins plugin', () => {
  // The hooks are plain functions on the plugin object; call them the way Rolldown would.
  type Hooks = { onLog: (level: string, log: unknown) => void; buildEnd: () => void };
  const hooks = (plugin: ReturnType<typeof failOnExternalizedBuiltins>) => plugin as unknown as Hooks;

  it('does not throw from onLog (Rolldown swallows that) but fails buildEnd', () => {
    const plugin = hooks(failOnExternalizedBuiltins([]));
    expect(() => plugin.onLog('warn', { message: externalized('node:util') })).not.toThrow();
    expect(() => plugin.buildEnd()).toThrow(/Node builtin "node:util"/);
  });

  it('reports each distinct violation once and resets afterwards', () => {
    const plugin = hooks(failOnExternalizedBuiltins([]));
    plugin.onLog('warn', { message: externalized('node:util') });
    plugin.onLog('warn', { message: externalized('node:util') });
    plugin.onLog('warn', { message: externalized('node:fs') });
    let message = '';
    try {
      plugin.buildEnd();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.match(/Node builtin "node:util"/g)).toHaveLength(1);
    expect(message).toContain('Node builtin "node:fs"');
    expect(() => plugin.buildEnd()).not.toThrow();
  });

  it('lets a clean build and an allow-listed builtin through', () => {
    const clean = hooks(failOnExternalizedBuiltins([]));
    clean.onLog('warn', { message: 'unrelated' });
    expect(() => clean.buildEnd()).not.toThrow();

    const allowed = hooks(failOnExternalizedBuiltins([{ specifier: 'node:util', importer: '/node_modules/better-ajv-errors/', reason: 'test' }]));
    allowed.onLog('warn', { message: externalized('node:util') });
    expect(() => allowed.buildEnd()).not.toThrow();
  });

  it('only applies to builds', () => {
    expect(failOnExternalizedBuiltins().apply).toBe('build');
  });
});
