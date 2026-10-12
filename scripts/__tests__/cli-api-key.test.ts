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
        stdout: sql.includes('information_schema') ? 't' : '7\nINSERT 0 1',
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

  /**
   * The key fleet QA holds instead of the device key. What matters is that it is minted alone and
   * read-only: one row that also carried 'mcp' would be the whole tool surface under a name that says
   * "read", and 'write' in the listing would make a test key look like it can change things.
   */
  describe('qa:read keys', () => {
    it('mints one with --scope in either flag form, stored as read', () => {
      runApiKeyCommand(['create', '--name', 'fleet-qa', '--scope', 'qa:read']);
      expect(insertSql()).toContain("ARRAY['qa:read']::text[]");
      expect(insertSql()).toContain("'read'");
      expect(insertSql()).not.toContain("'write'");

      mockedSpawnSync.mockClear();
      runApiKeyCommand(['create', '--name', 'fleet-qa', '--scope=qa:read']);
      expect(insertSql()).toContain("ARRAY['qa:read']::text[]");
    });

    it('prints the routes the key opens, so whoever mints it sees its whole authority', () => {
      runApiKeyCommand(['create', '--name', 'fleet-qa', '--scopes', 'qa:read']);

      const printed = (logSpy.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');
      expect(printed).toContain('GET /api/inference/pool/routing-log');
      expect(printed).toContain('Every other route refuses it.');
    });

    it('refuses to put it on the same key as another scope', () => {
      expect(() => runApiKeyCommand(['create', '--name', 'fleet-qa', '--scopes', 'mcp,qa:read'])).toThrow('exit');
      expect(errorText()).toContain("The 'qa:read' scope must be the only scope on its key");
      expect(insertSql()).toBeUndefined();
    });

    it('refuses --scope and --scopes together, instead of silently minting the wider key', () => {
      expect(() => runApiKeyCommand(['create', '--name', 'fleet-qa', '--scopes', 'mcp', '--scope', 'qa:read'])).toThrow('exit');
      expect(errorText()).toContain('Give --scope or --scopes, not both');
      expect(insertSql()).toBeUndefined();
    });

    it('refuses a capability wider than read, which the key could never use', () => {
      expect(() => runApiKeyCommand(['create', '--name', 'fleet-qa', '--scope', 'qa:read', '--capability', 'full'])).toThrow('exit');
      expect(errorText()).toContain('--capability full would do nothing');
      expect(insertSql()).toBeUndefined();
    });
  });

  /**
   * The key an editor or SDK holds in a config file that syncs to clouds. Same two invariants as
   * qa:read, for a worse leak path: one row that also carried 'mcp' would turn a leaked Continue
   * config into the whole MCP tool surface, and 'write' in the listing would make a GPU-only key look
   * like it can change things. The box must print the two base URLs, because that is the field the
   * operator fills in next and a route list would make them derive it.
   */
  describe('inference keys', () => {
    it('mints one with --scope in either flag form, stored as read', () => {
      runApiKeyCommand(['create', '--name', 'laptop-editor', '--scope', 'inference']);
      expect(insertSql()).toContain("ARRAY['inference']::text[]");
      expect(insertSql()).toContain("'read'");
      expect(insertSql()).not.toContain("'write'");

      mockedSpawnSync.mockClear();
      runApiKeyCommand(['create', '--name', 'laptop-editor', '--scope=inference']);
      expect(insertSql()).toContain("ARRAY['inference']::text[]");
    });

    it('prints both base URLs the key opens, so whoever mints it can paste one into an editor', () => {
      runApiKeyCommand(['create', '--name', 'laptop-editor', '--scopes', 'inference']);

      const printed = (logSpy.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');
      expect(printed).toContain('Accepted only on the inference routes:');
      expect(printed).toContain('http://<hub-host>:5002/api/inference/v1');
      expect(printed).toContain('http://<hub-host>:5002/api/inference/pool');
      expect(printed).toContain('Every other route refuses it.');
      // The qa:read route list is a different key's authority; printing it here would overstate this one.
      expect(printed).not.toContain('GET /api/inference/pool/routing-log');
      expect(printed).toContain('Revoke it in Settings → Security.');
    });

    it('refuses to put it on the same key as another scope', () => {
      expect(() => runApiKeyCommand(['create', '--name', 'laptop-editor', '--scopes', 'mcp,inference'])).toThrow('exit');
      expect(errorText()).toContain("The 'inference' scope must be the only scope on its key");
      expect(insertSql()).toBeUndefined();
    });

    it('refuses the two standalone scopes together, naming both', () => {
      expect(() => runApiKeyCommand(['create', '--name', 'laptop-editor', '--scopes', 'qa:read,inference'])).toThrow('exit');
      expect(errorText()).toContain("Each of 'qa:read' and 'inference' must be the only scope on its key");
      expect(insertSql()).toBeUndefined();
    });

    it('refuses a capability wider than read, which gates MCP tools the key never reaches', () => {
      expect(() => runApiKeyCommand(['create', '--name', 'laptop-editor', '--scope', 'inference', '--capability', 'full'])).toThrow('exit');
      expect(errorText()).toContain('--capability full would do nothing');
      expect(errorText()).toContain('capability gates MCP tools only');
      expect(insertSql()).toBeUndefined();
    });

    it('accepts an explicit --capability read, which is what it would have stored anyway', () => {
      runApiKeyCommand(['create', '--name', 'laptop-editor', '--scope', 'inference', '--capability', 'read']);
      expect(insertSql()).toContain("ARRAY['inference']::text[]");
      expect(insertSql()).toContain("'read'");
    });
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

/** A finished `spawnSync`, typed for the mock. */
function spawned(stdout: string, status = 0): ReturnType<typeof spawnSync> {
  return { status, stdout, stderr: '', output: ['', ''], pid: 0, signal: null } as ReturnType<typeof spawnSync>;
}

/** Every SQL statement sent to psql, by either route: it is always the last argument. */
const sentSql = () => (mockedSpawnSync.mock.calls as unknown[][]).map((call) => String((call[1] as string[]).at(-1)));

/**
 * The Windows Hub from the manual test, whose desktop app points the docker CLI at the Docker engine
 * it runs in WSL2. There `docker exec` exits 0 and prints nothing, whatever psql did. Here `docker cp`
 * finds nothing to copy either, so the CLI has no way to read an answer.
 */
describe('api-key when psql output never comes back', () => {
  const ENV_KEYS = ['DOCKER_HOST', 'DOCKER_CONTEXT'] as const;
  const saved = new Map<string, string | undefined>();
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let clockSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.DOCKER_CONTEXT = 'wsl-engine';
    // Each failed copy moves the clock a minute on, so the wait for psql's answer gives up at once
    // instead of after its real 30 seconds.
    let now = Date.now();
    clockSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockedSpawnSync.mockReset();
    mockedSpawnSync.mockImplementation((_command, args) => {
      const [verb] = args as string[];
      if (verb === 'context') return spawned('tcp://127.0.0.1:2375\n');
      if (verb === 'cp') {
        now += 60_000;
        return spawned('', 1);
      }
      return spawned('');
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clockSpy.mockRestore();
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  const printed = () => (logSpy.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');

  it('creates no key for --capability read, where it used to create one the Hub reads as read and write', () => {
    expect(() => runApiKeyCommand(['create', '--name', 'cli test', '--capability', 'read'])).toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(sentSql().some((sql) => sql.startsWith('INSERT INTO api_key'))).toBe(false);
    // It tried to copy the answer out before giving up, and names the engine it could not read.
    expect((mockedSpawnSync.mock.calls as unknown[][]).some((call) => (call[1] as string[])[0] === 'cp')).toBe(true);
    expect(printed()).toContain('Docker context wsl-engine (tcp://127.0.0.1:2375)');
  });

  it('says it could not read the keys, instead of saying there are none', () => {
    expect(() => runApiKeyCommand(['list'])).toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(printed()).not.toContain('(none');
    expect(printed()).toContain('Docker context wsl-engine (tcp://127.0.0.1:2375)');
  });
});

/** A Hub released before per-key capability, whose api_key table has no capability column. */
describe('api-key create on a Hub that predates per-key capability', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedSpawnSync.mockReset();
    mockedSpawnSync.mockImplementation((_command, args) =>
      spawned(String((args as string[]).at(-1)).includes('information_schema') ? 'f' : '7\nINSERT 0 1'),
    );
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  const printed = () => (logSpy.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');
  const insertSql = () => sentSql().find((sql) => sql.startsWith('INSERT INTO api_key'));

  it('refuses an explicit --capability, which this Hub cannot store, instead of creating a key that ignores it', () => {
    expect(() => runApiKeyCommand(['create', '--name', 'cli test', '--capability', 'read'])).toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(insertSql()).toBeUndefined();
    expect(printed()).toContain('--capability read');
  });

  it('still creates a key when no capability was asked for, and says it can do everything its scopes allow', () => {
    runApiKeyCommand(['create', '--name', 'laptop']);

    expect(insertSql()).toContain("VALUES ('laptop'");
    expect(insertSql()).not.toContain('capability');
    expect(printed()).toContain('everything its scopes allow');
  });
});
