import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  backupFile,
  backupPathFor,
  checkMemorySlot,
  HERMES_PACKAGE,
  hermesPluginDir,
  hubMcpUrl,
  lintFindingsForOurKeys,
  mergeOpenClawConfig,
  normalizeMemoryUrl,
  openClawConfigPath,
  OPENCLAW_PACKAGE,
  PINNED_VERSIONS,
  parseConnectArgs,
  parseToolsListBody,
  PLUGIN_ID,
  probeHubMcp,
  readJsonIfPresent,
  run,
  runFailureMessage,
  tarballUrl,
  timestampForBackup,
  patchHermesMcpServers,
  triageMcpProbe,
  triageMemoryAuth,
  triageMemoryProbe,
  urlProblem,
  writeFileAtomic,
} from '../lib/connect-agent';

describe('probe triage', () => {
  it('names the x-api-key mistake rather than just reporting 401', () => {
    const v = triageMemoryProbe(401);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('unauthorized');
    // The point of triage: a bare "401" sends people to re-mint a working key.
    expect(v.hint).toMatch(/x-api-key/);
  });

  it('treats 405 as a wrong path, which is what a bare /mcp answers', () => {
    expect(triageMemoryProbe(405).code).toBe('wrong-path');
  });

  it('reports an unreachable host distinctly from an HTTP error', () => {
    const v = triageMemoryProbe(undefined, 'getaddrinfo ENOTFOUND memory.example.com');
    expect(v.code).toBe('unreachable');
    // Reachability is the most common real-world cause and the hint has to say so.
    expect(v.hint).toMatch(/reachable from THIS machine/i);
  });

  it('passes a healthy memory server', () => {
    expect(triageMemoryProbe(200).ok).toBe(true);
  });

  // /api/health is unauthenticated — verified live, it answers 200 with no key and 200
  // with a junk one. The health leg must therefore never claim the key works, or connect
  // reports success for a key that cannot write a single turn.
  it('does not claim the key works on the unauthenticated health check', () => {
    expect(triageMemoryProbe(200).message).not.toMatch(/key/i);
  });

  it('names a 403 on the memory API as the missing Memory scope, not a bad key', () => {
    const v = triageMemoryAuth(403);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('missing-memory-scope');
    // The whole failure mode: an MCP-minted key authenticates and is refused here, and
    // the plugin swallows the resulting write failures.
    expect(v.hint).toMatch(/Memory/);
    expect(v.hint).toMatch(/silently|never accumulates/i);
  });

  it('separates a rejected key from an under-scoped one', () => {
    expect(triageMemoryAuth(401).code).toBe('unauthorized');
    expect(triageMemoryAuth(403).code).not.toBe('unauthorized');
  });

  it('promises only what a read probe proves', () => {
    const v = triageMemoryAuth(200);
    expect(v.ok).toBe(true);
    // Capture needs write capability, which cannot be probed without writing.
    expect(v.message).toMatch(/read/i);
  });

  // The trap this exists for: the call succeeds, so nothing looks wrong.
  it('calls out a 0-tool listing as the missing intents scope', () => {
    const v = triageMcpProbe(200, 0);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('missing-intents-scope');
    expect(v.hint).toMatch(/intents/);
  });

  it('recognises the pre-G1 alternating-400 gateway signature', () => {
    const v = triageMcpProbe(400, undefined, true);
    expect(v.code).toBe('pre-g1-gateway');
    expect(v.hint).toMatch(/retry|update/i);
  });

  it('distinguishes Hub Bearer auth from memory x-api-key auth', () => {
    // Mixing the two headers is the usual cause, and the two hints must not be identical.
    expect(triageMcpProbe(401, undefined).hint).toMatch(/Bearer/);
    expect(triageMemoryProbe(401).hint).not.toMatch(/Bearer <key>/);
  });

  it('passes a healthy MCP endpoint and reports the tool count', () => {
    const v = triageMcpProbe(200, 76);
    expect(v.ok).toBe(true);
    expect(v.message).toMatch(/76/);
  });
});

/**
 * The triage tests above take a status code as an argument, so they can say nothing
 * about whether the probe elicits the right status from a real server. It did not: the
 * probe sent `tools/list` with no session header, the Hub answered 400, and a healthy
 * Hub was reported as the pre-G1 gateway on every single run. Only a server that
 * enforces the contract catches that, so this stands one up.
 */
describe('probeHubMcp against a server enforcing the Hub session contract', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  /** Mirrors mcp.controller.ts handlePost + handleDelete. */
  function startHub(options: { stateless?: boolean; toolCount?: number; rpcError?: string } = {}): Promise<string> {
    const { stateless = false, toolCount = 76, rpcError } = options;
    const sessions = new Set<string>();
    const deleted: string[] = [];

    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        const sid = req.headers['mcp-session-id'] as string | undefined;
        const send = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
          res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(payload));

        if (req.method === 'DELETE') {
          if (sid) deleted.push(sid);
          return send(200, { ok: true });
        }

        let body: { method?: string; id?: number } = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          /* fall through to the missing-session branch */
        }

        // Unknown session id -> 404, per the controller.
        if (sid && !sessions.has(sid)) {
          return send(404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found; send an initialize request first.' } });
        }
        if (!sid) {
          if (body.method !== 'initialize') {
            // A stateless server (SDK with no sessionIdGenerator) skips session
            // validation entirely, so an unsessioned tools/list is legitimate there.
            if (stateless) {
              return send(200, {
                jsonrpc: '2.0',
                id: body.id,
                result: { tools: Array.from({ length: toolCount }, (_, i) => ({ name: `tool_${i}` })) },
              });
            }
            // The exact 400 that made a healthy Hub look pre-G1.
            return send(400, {
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Missing Mcp-Session-Id header; send an initialize request first.' },
            });
          }
          const issued = `sess-${sessions.size + 1}`;
          if (!stateless) sessions.add(issued);
          return send(
            200,
            {
              jsonrpc: '2.0',
              id: body.id,
              result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'ci-hub', version: '1' } },
            },
            // A stateless Hub (no sessionIdGenerator) issues no header and validates none.
            stateless ? {} : { 'mcp-session-id': issued },
          );
        }
        if (body.method === 'tools/list') {
          // JSON-RPC application errors ride inside a 200, which is the trap.
          if (rpcError) return send(200, { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: rpcError } });
          return send(200, { jsonrpc: '2.0', id: body.id, result: { tools: Array.from({ length: toolCount }, (_, i) => ({ name: `tool_${i}` })) } });
        }
        return send(200, { jsonrpc: '2.0', id: body.id, result: {} });
      });
    });

    (server as Server & { deleted: string[] }).deleted = deleted;
    return new Promise((resolve) => server?.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server?.address() as AddressInfo).port}`)));
  }

  it('carries the session id from initialize into tools/list', async () => {
    const verdict = await probeHubMcp(await startHub(), 'testkey');
    expect(verdict.code).toBe('ok');
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toMatch(/76/);
  });

  it('releases the session instead of leaving it for the 30-minute reaper', async () => {
    const url = await startHub();
    await probeHubMcp(url, 'testkey');
    expect((server as Server & { deleted: string[] }).deleted).toEqual(['sess-1']);
  });

  it('invents no session id for a server that issued none', async () => {
    // Not reachable on CI-Hub today — mcp-session.registry.ts always passes a
    // sessionIdGenerator — but a fabricated id would earn "Session not found" (404)
    // from any MCP server, so the header stays conditional on one being issued.
    const verdict = await probeHubMcp(await startHub({ stateless: true }), 'testkey');
    expect(verdict.code).toBe('ok');
  });

  it('fails on a JSON-RPC error even though the status is 200', async () => {
    // Status alone says nothing here: the transport succeeded, the CALL was refused.
    const verdict = await probeHubMcp(await startHub({ rpcError: 'key lacks intents scope' }), 'testkey');
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('rpc-error');
    expect(verdict.message).toMatch(/key lacks intents scope/);
  });

  it('still reports a 0-tool listing as the missing intents scope', async () => {
    const verdict = await probeHubMcp(await startHub({ toolCount: 0 }), 'testkey');
    expect(verdict.code).toBe('missing-intents-scope');
  });
});

describe('memory slot guard', () => {
  it('proceeds when the slot is unset', () => {
    expect(checkMemorySlot({}, false).ok).toBe(true);
  });

  it('proceeds when the slot is already ours', () => {
    expect(checkMemorySlot({ plugins: { slots: { memory: PLUGIN_ID } } }, false).ok).toBe(true);
  });

  // The guard cannot be delegated: `plugins install` force-switches a foreign slot
  // with no prompt, so by the time the installer has run the old value is gone.
  it('refuses a foreign slot without --force, and names the holder', () => {
    const v = checkMemorySlot({ plugins: { slots: { memory: 'memory-lancedb' } } }, false);
    expect(v.ok).toBe(false);
    expect(v.current).toBe('memory-lancedb');
    expect(v.message).toMatch(/memory-lancedb/);
    expect(v.message).toMatch(/--force/);
  });

  it('claims a foreign slot with --force', () => {
    expect(checkMemorySlot({ plugins: { slots: { memory: 'memory-lancedb' } } }, true).ok).toBe(true);
  });
});

describe('openclaw config merge', () => {
  const input = { url: 'https://memory.example.com', token: 'secret' };

  it('writes every key the npm install does not', () => {
    const { config } = mergeOpenClawConfig({}, input);
    const plugins = config.plugins as Record<string, any>;
    expect(plugins.slots.memory).toBe(PLUGIN_ID);
    expect(plugins.entries[PLUGIN_ID].enabled).toBe(true);
    // Without this, passive capture silently does nothing — the whole point of Tier 2.
    expect(plugins.entries[PLUGIN_ID].hooks.allowConversationAccess).toBe(true);
    expect(plugins.entries[PLUGIN_ID].config).toEqual(input);
    expect((config.tools as any).alsoAllow).toContain('memory_store');
    expect((config.hooks as any).internal.entries['session-memory'].enabled).toBe(false);
  });

  it('is idempotent — a second run reports no changes', () => {
    const first = mergeOpenClawConfig({}, input);
    expect(first.changes.length).toBeGreaterThan(0);
    const second = mergeOpenClawConfig(first.config, input);
    expect(second.changes).toEqual([]);
  });

  it('does not mutate the caller’s config', () => {
    // A failed lint restores from the backup; if the in-memory copy had been mutated
    // the restore would silently disagree with what we thought we wrote.
    const existing = { plugins: { slots: { memory: 'memory-core' } } };
    mergeOpenClawConfig(existing, input);
    expect(existing.plugins.slots.memory).toBe('memory-core');
  });

  it('appends to tools.alsoAllow rather than replacing it', () => {
    const { config } = mergeOpenClawConfig({ tools: { alsoAllow: ['some_other_tool'] } }, input);
    expect((config.tools as any).alsoAllow).toEqual(['some_other_tool', 'memory_store']);
  });

  it('never creates tools.allow, which would deny every tool not named in it', () => {
    const { config } = mergeOpenClawConfig({}, input);
    expect((config.tools as any).allow).toBeUndefined();
  });

  it('replaces a non-object sitting where a section belongs', () => {
    // `??=` would leave these alone, because they are neither null nor undefined, and
    // the merge would then throw on the first property write — halfway through, on a
    // config file it had already begun editing.
    const { config } = mergeOpenClawConfig({ plugins: 'core', tools: ['memory_get'] } as unknown as Record<string, unknown>, input);
    expect((config.plugins as any).slots.memory).toBe(PLUGIN_ID);
    expect((config.tools as any).alsoAllow).toEqual(['memory_store']);
  });

  it('preserves unrelated config', () => {
    const { config } = mergeOpenClawConfig({ gateway: { mode: 'local' }, plugins: { entries: { other: { enabled: true } } } }, input);
    expect((config.gateway as any).mode).toBe('local');
    expect((config.plugins as any).entries.other.enabled).toBe(true);
  });
});

describe('url handling', () => {
  it('strips a trailing slash and a legacy /api/mcp suffix', () => {
    expect(normalizeMemoryUrl('https://memory.example.com/')).toBe('https://memory.example.com');
    expect(normalizeMemoryUrl('https://memory.example.com/api/mcp')).toBe('https://memory.example.com');
    expect(normalizeMemoryUrl('  https://memory.example.com/api/mcp/  ')).toBe('https://memory.example.com');
  });

  it('accepts http and https', () => {
    expect(urlProblem('http://192.168.1.10:8642', '--memory-url')).toBeUndefined();
    expect(urlProblem('https://memory.example.com', '--memory-url')).toBeUndefined();
  });

  // A bare host:port parses as a URL whose SCHEME is the hostname, so fetch throws and
  // the probe blamed the network — sending people to inspect a firewall that was fine.
  it('names a missing scheme instead of letting it surface as unreachable', () => {
    const problem = urlProblem('memory.example.com:8642', '--memory-url');
    expect(problem).toMatch(/needs a scheme|read as the scheme/);
    expect(problem).toMatch(/--memory-url/);
  });

  it('rejects a scheme that cannot be probed', () => {
    expect(urlProblem('ftp://memory.example.com', '--memory-url')).toMatch(/only http:\/\/ and https:\/\//);
  });

  it('rejects an empty url', () => {
    expect(urlProblem('   ', '--memory-url')).toMatch(/empty/);
  });

  // Asserted against the shape actually published — the Hermes README hands this exact
  // URL to users, so a change here breaks a documented copy-paste install.
  it('builds the registry tarball URL the docs publish', () => {
    expect(tarballUrl(HERMES_PACKAGE, '2026.8.3')).toBe(
      'https://registry.npmjs.org/@companionintelligence/hermes-memory/-/hermes-memory-2026.8.3.tgz',
    );
    expect(tarballUrl(OPENCLAW_PACKAGE, '2026.8.3')).toBe(
      'https://registry.npmjs.org/@companionintelligence/openclaw-memory/-/openclaw-memory-2026.8.3.tgz',
    );
  });
});

describe('version pins', () => {
  // `connect` installs what this Hub release was tested against. A floating tag would
  // turn an unrelated npm publish into an untested change on someone's machine.
  it('are concrete versions, never a dist-tag', () => {
    for (const version of Object.values(PINNED_VERSIONS)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
      expect(version).not.toBe('latest');
    }
  });
});

describe('lint finding attribution', () => {
  const finding = (path: string, severity = 'error') => JSON.stringify({ findings: [{ path, severity, message: 'bad' }] });

  it('ignores findings about config we did not write', () => {
    // Restoring a good write because an unrelated skill is missing its binary would be
    // worse than not checking at all.
    expect(lintFindingsForOurKeys(finding('gateway.mode'))).toEqual([]);
    expect(lintFindingsForOurKeys(finding('skills.entries.tmux.enabled'))).toEqual([]);
  });

  it('claims findings about keys we did write', () => {
    expect(lintFindingsForOurKeys(finding('plugins.slots.memory'))).toHaveLength(1);
    expect(lintFindingsForOurKeys(finding(`plugins.entries.${PLUGIN_ID}.config.url`))).toHaveLength(1);
  });

  it('ignores warnings — only errors justify a rollback', () => {
    expect(lintFindingsForOurKeys(finding('plugins.slots.memory', 'warning'))).toEqual([]);
  });

  it('survives unparseable lint output', () => {
    expect(lintFindingsForOurKeys('not json')).toEqual([]);
  });
});

describe('tools/list body parsing', () => {
  const tools = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: `tool_${i}` })));
  const envelope = (n: number) => `{"jsonrpc":"2.0","id":2,"result":{"tools":${tools(n)}}}`;

  it('reads a plain JSON body', () => {
    expect(parseToolsListBody(envelope(76))).toEqual({ toolCount: 76 });
  });

  it('reads an SSE body', () => {
    expect(parseToolsListBody(`event: message\ndata: ${envelope(76)}\n\n`)).toEqual({ toolCount: 76 });
  });

  it('reads an SSE body carrying id and retry fields', () => {
    expect(parseToolsListBody(`event: message\nid: 12345678\nretry: 3000\ndata: ${envelope(3)}\n\n`)).toEqual({ toolCount: 3 });
  });

  // The old scan sliced 40 characters before `"result"`. Anything ahead of `result`
  // pushed it past the envelope brace, onto the inner `{"tools":`, and the parse failed
  // — which then read as a healthy server, with the 0-tool check skipped.
  it('survives fields ahead of result, which used to break the offset scan', () => {
    expect(parseToolsListBody(`{"jsonrpc":"2.0","id":2,"_meta":{"traceId":"abc123def456"},"result":{"tools":${tools(2)}}}`)).toEqual({
      toolCount: 2,
    });
    expect(parseToolsListBody(`{"jsonrpc":"2.0","id":"3f7c1e2a-9b44-4c1d-8a55-0d6e2f1b7c99","result":{"tools":${tools(2)}}}`)).toEqual({
      toolCount: 2,
    });
  });

  it('distinguishes an empty tool list from an unreadable one', () => {
    expect(parseToolsListBody(envelope(0))).toEqual({ toolCount: 0 });
    expect(parseToolsListBody('not json at all')).toEqual({ rpcError: undefined });
  });

  it('surfaces a JSON-RPC error, which rides inside a 200', () => {
    const body = '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"key lacks intents scope"}}';
    expect(parseToolsListBody(body)).toEqual({ rpcError: 'key lacks intents scope' });
  });

  it('skips notifications preceding the real answer in one stream', () => {
    const stream = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${envelope(5)}\n\n`;
    expect(parseToolsListBody(stream)).toEqual({ toolCount: 5 });
  });

  it('joins the consecutive data lines of one event, per the SSE grammar', () => {
    const split = envelope(2);
    // Split between tokens (right after `"id":2,`) so the newline the SSE grammar
    // inserts on join is legal JSON whitespace — then a correct join parses, and
    // treating each data line as its own message cannot.
    const at = '{"jsonrpc":"2.0","id":2,'.length;
    const body = `event: message\ndata: ${split.slice(0, at)}\ndata: ${split.slice(at)}\n\n`;
    expect(parseToolsListBody(body)).toEqual({ toolCount: 2 });
  });
});

/**
 * These must match the CLI, not merely be plausible. The original used
 * OPENCLAW_CONFIG_DIR, which OpenClaw honors nowhere — so under it the installer edited
 * the real config while the merge went to a phantom file, and the slot guard inspected
 * that phantom instead of the config it was protecting.
 */
describe('openclaw config path resolution', () => {
  const saved = { path: process.env.OPENCLAW_CONFIG_PATH, state: process.env.OPENCLAW_STATE_DIR };

  afterEach(() => {
    for (const [key, value] of [
      ['OPENCLAW_CONFIG_PATH', saved.path],
      ['OPENCLAW_STATE_DIR', saved.state],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('defaults to ~/.openclaw/openclaw.json', () => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_STATE_DIR;
    expect(openClawConfigPath('/home/someone')).toBe('/home/someone/.openclaw/openclaw.json');
  });

  it('honors OPENCLAW_CONFIG_PATH as a full file path', () => {
    delete process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_CONFIG_PATH = '/tmp/elsewhere/openclaw.json';
    expect(openClawConfigPath('/home/someone')).toBe('/tmp/elsewhere/openclaw.json');
  });

  it('reads OPENCLAW_STATE_DIR as a directory containing openclaw.json', () => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    process.env.OPENCLAW_STATE_DIR = '/tmp/state';
    expect(openClawConfigPath('/home/someone')).toBe('/tmp/state/openclaw.json');
  });

  it('lets OPENCLAW_CONFIG_PATH win over OPENCLAW_STATE_DIR, as the CLI does', () => {
    process.env.OPENCLAW_STATE_DIR = '/tmp/state';
    process.env.OPENCLAW_CONFIG_PATH = '/tmp/elsewhere/openclaw.json';
    expect(openClawConfigPath('/home/someone')).toBe('/tmp/elsewhere/openclaw.json');
  });

  it('ignores an empty value rather than resolving to a bare filename', () => {
    delete process.env.OPENCLAW_CONFIG_PATH;
    process.env.OPENCLAW_STATE_DIR = '   ';
    expect(openClawConfigPath('/home/someone')).toBe('/home/someone/.openclaw/openclaw.json');
  });
});

describe('reading an existing config', () => {
  const tmp = (name: string, body: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'connect-agent-')), name);
    writeFileSync(path, body);
    return path;
  };

  it('treats a missing file as an empty config', () => {
    expect(readJsonIfPresent(join(tmpdir(), 'connect-agent-does-not-exist.json'))).toEqual({});
  });

  it('reads an object', () => {
    expect(readJsonIfPresent(tmp('openclaw.json', '{"gateway":{"mode":"local"}}'))).toEqual({ gateway: { mode: 'local' } });
  });

  it('refuses malformed JSON rather than overwriting it', () => {
    expect(() => readJsonIfPresent(tmp('openclaw.json', '{oops'))).toThrow(/not valid JSON/);
  });

  // Valid JSON, wrong shape: the merge would write its keys onto an array, and
  // JSON.stringify drops non-index properties — so the file would come back as `[]`
  // with every setting silently gone.
  it('refuses valid JSON that is not a config object', () => {
    expect(() => readJsonIfPresent(tmp('openclaw.json', '[1,2]'))).toThrow(/an array, not a config object/);
    expect(() => readJsonIfPresent(tmp('openclaw.json', '"a string"'))).toThrow(/a string, not a config object/);
    expect(() => readJsonIfPresent(tmp('openclaw.json', 'null'))).toThrow(/a null, not a config object/);
  });
});

describe('connect argument parsing', () => {
  it('accepts the minimal form', () => {
    expect(parseConnectArgs(['openclaw', '--memory-url', 'https://m.example.com', '--memory-key', 'k'])).toEqual({
      agent: 'openclaw',
      memoryUrl: 'https://m.example.com',
      memoryKey: 'k',
      hubUrl: undefined,
      hubKey: undefined,
      force: false,
      dryRun: false,
    });
  });

  it('reads the boolean flags in any position', () => {
    const parsed = parseConnectArgs(['hermes', '--dry-run', '--memory-url', 'https://m', '--force', '--memory-key', 'k']);
    expect(parsed.force).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.memoryKey).toBe('k');
  });

  it('rejects a missing or unknown agent instead of connecting something', () => {
    expect(parseConnectArgs([]).error).toMatch(/needs an agent/);
    expect(parseConnectArgs(['claude']).error).toMatch(/got 'claude'/);
  });

  // The whole reason the guard exists: this used to probe the literal "--memory-key"
  // as a URL and report it unreachable.
  it('refuses a flag whose value is the next flag', () => {
    expect(parseConnectArgs(['openclaw', '--memory-url', '--memory-key', 'k']).error).toBe('--memory-url needs a value.');
  });

  it('refuses a trailing flag with nothing after it', () => {
    expect(parseConnectArgs(['openclaw', '--memory-key']).error).toBe('--memory-key needs a value.');
  });

  it('requires the hub flags together, since one alone cannot authenticate', () => {
    const base = ['openclaw', '--memory-url', 'https://m', '--memory-key', 'k'];
    expect(parseConnectArgs([...base, '--hub-url', 'https://h']).error).toMatch(/go together/);
    expect(parseConnectArgs([...base, '--hub-key', 'hk']).error).toMatch(/go together/);
    expect(parseConnectArgs([...base, '--hub-url', 'https://h', '--hub-key', 'hk']).error).toBeUndefined();
  });

  // Absent here is not an error — the CLI prompts for these on a TTY.
  it('leaves missing credentials to the caller rather than failing', () => {
    const parsed = parseConnectArgs(['hermes']);
    expect(parsed.error).toBeUndefined();
    expect(parsed.memoryUrl).toBeUndefined();
  });
});

describe('hub mcp url', () => {
  it('folds trailing slashes so the dry run cannot print //api/mcp', () => {
    expect(hubMcpUrl('https://hub.example.com/')).toBe('https://hub.example.com/api/mcp');
    expect(hubMcpUrl('https://hub.example.com///')).toBe('https://hub.example.com/api/mcp');
    expect(hubMcpUrl('https://hub.example.com')).toBe('https://hub.example.com/api/mcp');
  });
});

describe('hermes plugin dir', () => {
  const saved = process.env.HERMES_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = saved;
  });

  it('defaults to ~/.hermes', () => {
    delete process.env.HERMES_HOME;
    expect(hermesPluginDir('/home/someone')).toBe('/home/someone/.hermes/plugins/companionintelligence');
  });

  it('honors HERMES_HOME', () => {
    process.env.HERMES_HOME = '/tmp/elsewhere';
    expect(hermesPluginDir('/home/someone')).toBe('/tmp/elsewhere/plugins/companionintelligence');
  });

  // Without the trim, join roots the install under a directory literally named "   ".
  it('treats a whitespace-only value as unset, not as a path', () => {
    process.env.HERMES_HOME = '   ';
    expect(hermesPluginDir('/home/someone')).toBe('/home/someone/.hermes/plugins/companionintelligence');
  });
});

describe('subprocess failure reporting', () => {
  it('names a binary that could not be started, instead of "exited null"', () => {
    const result = run('definitely-not-a-real-binary-xyz', ['--version']);
    expect(result.ok).toBe(false);
    // spawnSync leaves status null and stderr empty here, so the status alone says
    // nothing about what went wrong.
    expect(result.status).toBeNull();
    expect(result.error).toBeDefined();
    const message = runFailureMessage(result, 'the thing');
    expect(message).toMatch(/could not run/);
    expect(message).not.toMatch(/null/);
  });

  it('prefers stderr when the process ran and failed', () => {
    const result = run('bash', ['-c', 'echo "the real reason" >&2; exit 3']);
    expect(runFailureMessage(result, 'the thing')).toBe('the real reason');
  });

  it('falls back to the exit status when a process fails silently', () => {
    expect(runFailureMessage(run('bash', ['-c', 'exit 4']), 'the thing')).toBe('the thing exited 4');
  });
});

describe('backups', () => {
  it('tightens the copy, since the source may be world-readable and hold a token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'connect-agent-backup-'));
    const source = join(dir, 'openclaw.json');
    writeFileSync(source, '{"gateway":{"auth":{"token":"secret"}}}');
    chmodSync(source, 0o644);

    const target = backupFile(source, 'stamp');
    expect(target).toBeDefined();
    // copyFileSync carries the source mode over, so without the explicit chmod this
    // would be a 0644 copy of a secret-bearing file that we chose to create.
    expect(statSync(target as string).mode & 0o777).toBe(0o600);
  });

  it('reports no backup when there was no file to copy', () => {
    expect(backupFile(join(tmpdir(), 'connect-agent-absent.json'), 'stamp')).toBeUndefined();
  });
});

describe('backup naming', () => {
  it('timestamps so consecutive runs never overwrite the safety net', () => {
    const a = backupPathFor('/tmp/openclaw.json', timestampForBackup(new Date('2026-08-03T10:00:00Z')));
    const b = backupPathFor('/tmp/openclaw.json', timestampForBackup(new Date('2026-08-03T10:00:01Z')));
    expect(a).not.toBe(b);
    expect(a.startsWith('/tmp/openclaw.json.')).toBe(true);
    expect(a.endsWith('.bak')).toBe(true);
    // Colons in an ISO timestamp are not portable in filenames.
    expect(a).not.toMatch(/:/);
  });
});

describe('hermes mcp_servers patch', () => {
  const URL = 'http://hub.local:5002/api/mcp';

  it('creates the section when the config has none', () => {
    const { text, changed } = patchHermesMcpServers('model: gpt\n', URL, 'k');
    expect(changed).toBe(true);
    expect(text).toMatch(/^model: gpt$/m);
    expect(text).toMatch(/^mcp_servers:$/m);
    expect(text).toMatch(/^ {2}hub:$/m);
    expect(text).toMatch(/Authorization: "Bearer k"/);
  });

  // Hermes defaults to Streamable HTTP for any entry with a url, and its only other
  // accepted value is sse — which these servers do not serve.
  it('never writes a transport line', () => {
    expect(patchHermesMcpServers('', URL, 'k').text).not.toMatch(/transport:/);
  });

  it('adds hub alongside an existing server without disturbing it', () => {
    const before = 'mcp_servers:\n  ci_server:\n    url: "http://m/api/mcp"\n    timeout: 600\n';
    const { text } = patchHermesMcpServers(before, URL, 'k');
    expect(text).toMatch(/ci_server:/);
    expect(text).toMatch(/timeout: 600/);
    expect(text).toMatch(/hub:/);
  });

  it('updates an existing hub block rather than duplicating it', () => {
    const once = patchHermesMcpServers('', URL, 'old').text;
    const { text, changed } = patchHermesMcpServers(once, URL, 'new');
    expect(changed).toBe(true);
    expect(text.match(/hub:/g)).toHaveLength(1);
    expect(text).toMatch(/Bearer new/);
    expect(text).not.toMatch(/Bearer old/);
  });

  // A converged config must not be rewritten — and therefore backed up — on every run.
  it('reports no change when the block already matches', () => {
    const once = patchHermesMcpServers('', URL, 'k').text;
    const { text, changed } = patchHermesMcpServers(once, URL, 'k');
    expect(changed).toBe(false);
    expect(text).toBe(once);
  });

  // Caught on a real config, not in this suite: with a blank line between the block and
  // the next top-level key, the comparison treated that blank as part of `hub` and so
  // never matched. Every run rewrote the file, took another backup, and ate the blank —
  // reformatting the user's config a line at a time.
  it('stays idempotent when another top-level key follows the block', () => {
    const before = 'mcp_servers:\n  ci_server:\n    url: "http://m/api/mcp"\n\nskills:\n  external_dirs:\n    - ~/.ci/skills\n';
    const once = patchHermesMcpServers(before, URL, 'k');
    expect(once.changed).toBe(true);

    const twice = patchHermesMcpServers(once.text, URL, 'k');
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
    // The separator survives, rather than being absorbed into the block.
    expect(once.text).toMatch(/connect_timeout: 60\n\nskills:/);
  });

  it('matches the surrounding indentation instead of assuming two spaces', () => {
    const before = 'mcp_servers:\n    ci_server:\n        url: "http://m/api/mcp"\n';
    const { text } = patchHermesMcpServers(before, URL, 'k');
    // A two-space block here would be read as a sibling of mcp_servers, not a child.
    expect(text).toMatch(/^ {4}hub:$/m);
  });

  it('keeps comments and unrelated keys', () => {
    const before = '# my hermes config\nmodel: gpt\n\nmcp_servers:\n  ci_server:\n    url: "http://m/api/mcp"\n';
    const { text } = patchHermesMcpServers(before, URL, 'k');
    expect(text).toMatch(/^# my hermes config$/m);
    expect(text).toMatch(/^model: gpt$/m);
  });

  it('does not weld the block onto a file with no trailing newline', () => {
    const { text } = patchHermesMcpServers('model: gpt', URL, 'k');
    expect(text).toMatch(/^model: gpt$/m);
    expect(text).toMatch(/^mcp_servers:$/m);
  });

  it('leaves a later top-level key below the inserted block', () => {
    const before = 'mcp_servers:\n  ci_server:\n    url: "http://m/api/mcp"\nskills:\n  external_dirs:\n    - ~/.ci/skills\n';
    const { text } = patchHermesMcpServers(before, URL, 'k');
    const lines = text.split('\n');
    expect(lines.findIndex((l) => l.startsWith('  hub:'))).toBeLessThan(lines.findIndex((l) => l.startsWith('skills:')));
  });
});

describe('hermes config write safety', () => {
  const URL = 'http://hub.local:5002/api/mcp';

  // A double quote is a legal HTTP header value, so a key containing one PASSES the Hub
  // probe and reaches the writer. Interpolated raw, it closed the YAML scalar early and
  // everything after it became configuration — including a second MCP server pointing
  // wherever the rest of the string said.
  it('cannot be escaped out of by a quote in the key', () => {
    const key = `"\n    evil: injected\n  other:\n    url: "http://attacker/api/mcp"\n#`;
    const { text } = patchHermesMcpServers('mcp_servers:\n  ci_server:\n    url: "http://m/api/mcp"\n', URL, key);

    // The payload survives as literal text INSIDE the scalar — that is the point, the
    // key is stored verbatim — so the test is structural, not a substring hunt.
    expect(text).not.toMatch(/^\s*evil:/m);
    expect(text).not.toMatch(/^\s*url: "http:\/\/attacker/m);
    // One server added, not two.
    expect(text.match(/^ {2}\w+:$/gm)).toEqual(['  ci_server:', '  hub:']);
    // Six lines is the whole hub block; injection shows up as extra ones.
    const all = text.split('\n');
    const hubBlock = all.slice(all.indexOf('  hub:')).filter((l) => l.trim() !== '');
    expect(hubBlock).toHaveLength(6);
  });

  it('cannot be escaped out of by a quote in the url', () => {
    const { text } = patchHermesMcpServers('', `"\nevil: injected\n#`, 'k');
    expect(text).not.toMatch(/^\s*evil:/m);
    expect(text.match(/^ {2}\w+:$/gm)).toEqual(['  hub:']);
  });

  it('keeps a key with awkward characters intact rather than mangling it', () => {
    const key = 'has"quote\\and\\backslash';
    const { text } = patchHermesMcpServers('', URL, key);
    // JSON.stringify output is a valid YAML 1.2 double-quoted scalar, so the value
    // survives a round trip instead of being silently altered.
    expect(text).toContain(JSON.stringify(`Bearer ${key}`));
  });

  // Appending a second `mcp_servers:` key is either a parse error or a silent
  // last-one-wins that drops the user's existing servers.
  it('refuses an inline mcp_servers mapping instead of duplicating the key', () => {
    const before = 'mcp_servers: {}\n';
    const { text, changed, problem } = patchHermesMcpServers(before, URL, 'k');
    expect(changed).toBe(false);
    expect(problem).toMatch(/inline/i);
    expect(text).toBe(before);
    expect(text.match(/mcp_servers:/g)).toHaveLength(1);
  });
});

describe('writeFileAtomic', () => {
  // writeFileSync's `mode` goes to open(2), which ignores it when the file exists. A
  // config already at 0644 would keep 0644 while gaining a bearer token.
  it('tightens permissions on a file that already existed at 0644', () => {
    const dir = mkdtempSync(join(tmpdir(), 'connect-agent-perm-'));
    const target = join(dir, 'config.yaml');
    writeFileSync(target, 'existing\n');
    chmodSync(target, 0o644);

    writeFileAtomic(target, 'with-a-token\n');

    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('creates a new file at 0600 and leaves no temp file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'connect-agent-perm-'));
    const target = join(dir, 'nested', 'config.yaml');

    writeFileAtomic(target, 'contents\n');

    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'nested'))).toEqual(['config.yaml']);
  });
});
