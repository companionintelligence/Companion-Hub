import { describe, expect, it } from 'vitest';
import {
  backupPathFor,
  checkMemorySlot,
  HERMES_PACKAGE,
  lintFindingsForOurKeys,
  mergeOpenClawConfig,
  normalizeMemoryUrl,
  OPENCLAW_PACKAGE,
  PINNED_VERSIONS,
  PLUGIN_ID,
  tarballUrl,
  timestampForBackup,
  triageMcpProbe,
  triageMemoryProbe,
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

describe('backups', () => {
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
