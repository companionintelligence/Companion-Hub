import { describe, expect, it } from 'vitest';
import type { InferenceBackendType } from '@ci-hub/common/types';
import {
  type EvalCandidateApp,
  type ProbedInventory,
  appArchClass,
  archCompatible,
  archSkipNote,
  browseFilters,
  catalogDrop,
  filterApps,
  filterModels,
  matchesQuery,
  modelPools,
  modelSkipNote,
  normalizeArch,
  partitionModels,
  promptSplit,
  runnableOnAny,
} from '../selection-filters';

describe('normalizeArch', () => {
  it('folds every spelling a machine or manifest uses onto the two names', () => {
    expect(['aarch64', 'arm64', 'armv8', 'armv8l', 'arm64/v8', ' ARM64 '].map(normalizeArch)).toEqual(Array(6).fill('arm64'));
    expect(['x86_64', 'x64', 'amd64', 'x86-64'].map(normalizeArch)).toEqual(Array(4).fill('amd64'));
  });

  it('never defaults an unreadable arch to amd64 — a wrong default is how an incompatible image gets dispatched', () => {
    expect(normalizeArch('riscv64')).toBe('unknown');
    expect(normalizeArch('')).toBe('unknown');
    expect(normalizeArch(null)).toBe('unknown');
    expect(normalizeArch(undefined)).toBe('unknown');
  });
});

describe('archCompatible', () => {
  it('lets an app that declares nothing run anywhere — there is no declaration to violate', () => {
    expect(archCompatible([], 'amd64')).toBe(true);
    expect(archCompatible(undefined, 'unknown')).toBe(true);
  });

  it('gives an unknown host only the apps that declare EVERY known arch', () => {
    expect(archCompatible(['amd64', 'arm64'], 'unknown')).toBe(true);
    expect(archCompatible(['amd64'], 'unknown')).toBe(false);
    expect(archCompatible(['arm64'], 'unknown')).toBe(false);
  });

  it('matches a known host against the declaration, normalizing both sides', () => {
    expect(archCompatible(['x86_64'], 'amd64')).toBe(true);
    expect(archCompatible(['aarch64'], 'amd64')).toBe(false);
  });

  it('is disabled entirely by mode off, for a caller that already resolved compatibility', () => {
    expect(archCompatible(['arm64'], 'amd64', 'off')).toBe(true);
  });
});

describe('runnableOnAny', () => {
  it('treats an empty target set as not runnable — nothing to dispatch to is not "runs anywhere"', () => {
    expect(runnableOnAny([], [])).toBe(false);
    expect(runnableOnAny(['amd64'], [])).toBe(false);
  });

  it('is true when any one selected target could take it', () => {
    expect(runnableOnAny(['arm64'], ['amd64', 'arm64'])).toBe(true);
    expect(runnableOnAny(['arm64'], ['amd64', 'unknown'])).toBe(false);
  });
});

describe('archSkipNote', () => {
  it('names both sides of the mismatch and says the row is a skip, not a pass and not a fail', () => {
    const note = archSkipNote(['arm64'], ['amd64', 'amd64', 'unknown']);
    expect(note).toContain('declares arm64');
    expect(note).toContain('selected targets offer amd64, unknown');
    expect(note).toContain('never a pass and never a fail');
  });

  it('says so when nothing is declared and nothing is selected, rather than printing empty lists', () => {
    expect(archSkipNote([], [])).toContain('declares nothing');
    expect(archSkipNote([], [])).toContain('no target');
  });
});

describe('catalogDrop', () => {
  const app: EvalCandidateApp = { id: 'notes', name: 'Notes App', categories: ['productivity'], priority: 'high', architectures: ['amd64', 'arm64'] };

  it('returns null when the app survives the whole chain', () => {
    expect(catalogDrop(app, {})).toBeNull();
    expect(catalogDrop(app, { arch: 'universal', categories: ['productivity'], priorities: ['high'], query: 'notes app' })).toBeNull();
  });

  it('lets exclusion beat inclusion, and says which list did it', () => {
    const reason = catalogDrop(app, { ids: ['notes'], excludeIds: ['notes'] });
    expect(reason).toBe('excludeIds lists notes');
  });

  it('gives every drop a reason that names the filter and what the app declared', () => {
    expect(catalogDrop(app, { ids: ['other'] })).toBe('not in the explicit ids list');
    expect(catalogDrop({ ...app, available: false }, { availableOnly: true })).toContain('available:false');
    expect(catalogDrop(app, { categories: ['media'] })).toBe('categories=media: app declares none of them');
    expect(catalogDrop(app, { priorities: ['low'] })).toBe('priorities=low: app is high');
    expect(catalogDrop({ ...app, architectures: ['amd64'] }, { arch: 'arm64' })).toBe('arch=arm64: app declares amd64');
    expect(catalogDrop(app, { query: 'ledger' })).toBe('query="ledger": no match in id, name or categories');
  });

  it('keeps an app whose availability was never claimed under availableOnly — absent is not false', () => {
    expect(catalogDrop(app, { availableOnly: true })).toBeNull();
  });
});

describe('matchesQuery', () => {
  it('ANDs the terms so typing more always narrows', () => {
    const app = { id: 'notes', name: 'Notes App', categories: ['productivity'] };
    expect(matchesQuery(app, 'notes')).toBe(true);
    expect(matchesQuery(app, 'notes productivity')).toBe(true);
    expect(matchesQuery(app, 'notes ledger')).toBe(false);
    expect(matchesQuery(app, '   ')).toBe(true);
    expect(matchesQuery(app, null)).toBe(true);
  });
});

describe('filterApps / browseFilters / appArchClass', () => {
  const apps: EvalCandidateApp[] = [
    { id: 'a', architectures: ['amd64', 'arm64'] },
    { id: 'b', architectures: ['amd64'] },
    { id: 'c', architectures: [] },
  ];

  it('keeps the catalog order of the survivors, leaving sorting and limit to the caller', () => {
    expect(filterApps(apps, { excludeIds: ['b'] }).map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('classifies the shapes a catalog actually contains', () => {
    expect(apps.map(appArchClass)).toEqual(['universal', 'amd64-only', 'undeclared']);
    expect(appArchClass({ architectures: ['arm64'] })).toBe('arm64-only');
  });

  it('drops the explicit id lists so a browse view shows what there is to pick from', () => {
    const b = browseFilters({ ids: ['a'], excludeIds: ['b'], arch: 'amd64', limit: 5 });
    expect(b.ids).toEqual([]);
    expect(b.excludeIds).toEqual([]);
    // `limit` is the caller's to apply to the sorted survivors, so a browse view carries none.
    expect(b.limit).toBeNull();
    // Everything that describes WHAT there is to pick from survives; only the picks themselves go.
    expect(b.arch).toBe('amd64');
    expect(b.query).toBe('');
    expect(filterApps(apps, b).map((a) => a.id)).toEqual(['a', 'b']);
    expect(browseFilters({ query: 'notes', categories: ['productivity'] })).toMatchObject({ query: 'notes', categories: ['productivity'] });
  });
});

describe('promptSplit', () => {
  const bank = [
    { id: 'p1', backends: ['ollama'] as InferenceBackendType[] },
    { id: 'p2', backends: ['vllm', 'mtplx'] as InferenceBackendType[] },
    { id: 'p3', backends: [] as InferenceBackendType[] },
  ];

  it('hides a prompt no selected backend can serve, rather than listing work the run will not do', () => {
    const { shown, hidden } = promptSplit(bank, ['ollama']);
    expect(shown.map((p) => p.id)).toEqual(['p1']);
    expect(hidden.map((p) => p.id)).toEqual(['p2', 'p3']);
  });

  it('treats an empty or absent selection as every backend, so nothing is hidden', () => {
    expect(promptSplit(bank, []).hidden).toEqual([]);
    expect(promptSplit(bank, null).shown).toHaveLength(3);
    expect(promptSplit(bank, undefined).shown).toHaveLength(3);
  });
});

describe('model pools and selection', () => {
  const inventory: ProbedInventory = {
    'b:11434': [{ backend: 'ollama', models: ['qwen3:8b', 'nomic-embed-text'] }],
    'a:11434': [
      { backend: 'ollama', models: ['qwen3:8b'] },
      { backend: 'vllm', models: ['qwen3:8b-mlx', ''] },
    ],
  };

  it('sorts pools by model name so two runs over the same inventory diff cleanly', () => {
    expect(modelPools(inventory).map((p) => p.model)).toEqual(['nomic-embed-text', 'qwen3:8b', 'qwen3:8b-mlx']);
    expect(modelPools(null)).toEqual([]);
  });

  it('records every endpoint and backend a model was seen on, and badges the MLX builds', () => {
    const pools = modelPools(inventory);
    const std = pools.find((p) => p.model === 'qwen3:8b');
    expect(std?.endpoints).toEqual(['b:11434', 'a:11434']);
    expect(std?.backends).toEqual(['ollama']);
    expect(std?.mlx).toBe(false);
    expect(pools.find((p) => p.model === 'qwen3:8b-mlx')?.mlx).toBe(true);
  });

  it('matches model pins EXACTLY, because an mlx tag is a different model and that is the point', () => {
    expect(filterModels(['qwen3:8b', 'qwen3:8b-mlx'], ['qwen3:8b'])).toEqual(['qwen3:8b']);
    expect(filterModels(['qwen3:8b'], [])).toEqual(['qwen3:8b']);
    expect(filterModels(['qwen3:8b'], null)).toEqual(['qwen3:8b']);
  });

  it('warns about a requested model the probe never saw rather than refusing the run on a cache', () => {
    const { known, unseen } = partitionModels(['qwen3:8b', 'llama9:70b'], inventory);
    expect(known).toEqual(['qwen3:8b']);
    expect(unseen).toEqual(['llama9:70b']);
  });

  it('distinguishes "your pins are not here" from "nothing is here", and never offers to pull', () => {
    const note = modelSkipNote('a:11434', 'ollama', 'chat', ['llama9:70b'], ['qwen3:8b', 'nomic-embed-text']);
    expect(note).toContain('none of the 1 selected model(s) is resident on a:11434/ollama for the chat role');
    expect(note).toContain('has: qwen3:8b, nomic-embed-text');
    expect(note).toContain('skipped rather than pulling one');
  });
});
