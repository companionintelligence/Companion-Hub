import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
import { runApiKeyCommand } from '../lib/cli-api-key';
import { stripAnsi } from '../lib/cli-ui';

const mockedSpawnSync = vi.mocked(spawnSync);

/**
 * `api-key create` is exercised end to end, with psql stubbed, because the flag bug was invisible in
 * every other view: a `--capability=full` that never reached the parser still produced a successful
 * "API key created" box. The only witness to what the operator actually got is the INSERT.
 */
describe('api-key create', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedSpawnSync.mockReset();
    mockedSpawnSync.mockImplementation((_command, args) => {
      const sql = String((args as string[]).at(-1));
      return {
        status: 0,
        stdout: sql.startsWith('SELECT 1 FROM information_schema') ? '1' : '7\nINSERT 0 1',
        stderr: '',
        output: ['', ''],
        pid: 0,
        signal: null,
      } as ReturnType<typeof spawnSync>;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /** The statement that decides what the key can do — absent when the command refused to mint. */
  const insertSql = () =>
    (mockedSpawnSync.mock.calls as unknown[][])
      .map((call) => String((call[1] as string[]).at(-1)))
      .find((sql) => sql.startsWith('INSERT INTO api_key'));

  const errorText = () => (errorSpy.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');

  it('grants the capability that was asked for, in either flag form', () => {
    runApiKeyCommand(['create', '--name', 'laptop', '--capability', 'full']);
    expect(insertSql()).toContain("'full'");

    mockedSpawnSync.mockClear();
    runApiKeyCommand(['create', '--name', 'laptop', '--capability=full']);
    expect(insertSql()).toContain("'full'");
    // The bug this pins: the inline form went unseen and the key was minted 'write' — a quieter
    // grant than the operator asked for, reported back as though it were the one they asked for.
    expect(insertSql()).not.toContain("'write'");
  });

  it('refuses an unknown capability in either flag form rather than falling back to the default', () => {
    expect(() => runApiKeyCommand(['create', '--name', 'laptop', '--capability', 'admin'])).toThrow('exit');
    expect(() => runApiKeyCommand(['create', '--name', 'laptop', '--capability=admin'])).toThrow('exit');
    expect(errorText()).toContain('Unknown capability: admin');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(insertSql()).toBeUndefined();
  });

  it('refuses a --capability with no value instead of reading the next flag as one', () => {
    expect(() => runApiKeyCommand(['create', '--name', 'laptop', '--capability'])).toThrow('exit');
    expect(() => runApiKeyCommand(['create', '--name', 'laptop', '--capability', '--scopes', 'mcp'])).toThrow('exit');
    expect(errorText()).toContain('Missing value for --capability.');
    expect(insertSql()).toBeUndefined();
  });

  // A *valid* --scopes cannot show that the value was read: 'mcp' is the only scope an operator key
  // may hold and also the default, so an ignored flag mints the same row. The refusals below are
  // what prove the value reached the parser.
  it('accepts --scopes in either flag form', () => {
    runApiKeyCommand(['create', '--name', 'laptop', '--scopes', 'mcp']);
    expect(insertSql()).toContain("ARRAY['mcp']::text[]");

    mockedSpawnSync.mockClear();
    runApiKeyCommand(['create', '--name', 'laptop', '--scopes=mcp']);
    expect(insertSql()).toContain("ARRAY['mcp']::text[]");
  });

  it('refuses an unknown scope in either flag form rather than falling back to mcp', () => {
    expect(() => runApiKeyCommand(['create', '--name', 'laptop', '--scopes', 'admin'])).toThrow('exit');
    expect(() => runApiKeyCommand(['create', '--name', 'laptop', '--scopes=admin'])).toThrow('exit');
    expect(errorText()).toContain('Unknown scope(s): admin');
    expect(insertSql()).toBeUndefined();
  });

  it('refuses the managed-only app scope in either flag form', () => {
    expect(() => runApiKeyCommand(['create', '--name', 'laptop', '--scopes', 'app'])).toThrow('exit');
    expect(() => runApiKeyCommand(['create', '--name', 'laptop', '--scopes=app'])).toThrow('exit');
    expect(errorText()).toContain("The 'app' scope is carried only by managed keys");
    expect(insertSql()).toBeUndefined();
  });

  it('reads --name in either flag form, and still refuses one that is a forgotten flag value', () => {
    runApiKeyCommand(['create', '--name=laptop', '--capability=read']);
    expect(insertSql()).toContain("VALUES ('laptop'");
    expect(insertSql()).toContain("'read'");

    // The space-separated form is caught by the flag reader, the inline one by the name rules.
    expect(() => runApiKeyCommand(['create', '--name', '--scopes', 'mcp'])).toThrow('exit');
    expect(() => runApiKeyCommand(['create', '--name=--scopes', '--scopes', 'mcp'])).toThrow('exit');
  });
});
