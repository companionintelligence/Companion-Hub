/**
 * `cihub fleet update --models` — one list per node, with its provenance on the record.
 *
 * The command used to apply one flat list to every machine. On this fleet that produced 2–23
 * models per node across hardware with nothing in common, and one node with no embedder at all.
 * These tests drive the command end to end against a mocked SSH transport and check what each
 * node is asked to pull, what the run says about where that list came from, and that a node whose
 * Hub cannot be asked still gets the platform floor rather than nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nodes: [] as import('../lib/fleet-roster.js').FleetNode[],
  sshCapture: vi.fn(),
}));

vi.mock('../lib/fleet-roster.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-roster.js')>()),
  loadFleetRoster: () => ({ nodes: mocks.nodes, source: 'test-roster', dropped: [] }),
}));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: mocks.sshCapture,
}));

import { FleetArgError, parseFleetArgs, runFleetCommand } from '../lib/cli-fleet.js';

const ok = (out: string) => ({ ok: true, out, err: '', code: 0, ms: 5 });

const PROFILE = {
  tier: 'medium',
  hardware: { gpu: { vendor: 'nvidia', model: 'RTX A1000', vramMb: 8192, unifiedMemory: false }, ram: { totalMb: 65536 } },
  backends: { recommended: 'ollama' },
  recommendedModels: [
    { id: 'qwen3-5-9b', backend: 'ollama', backendModelId: 'qwen3.5:9b', modality: 'llm', requirements: { diskMb: 6758 } },
    { id: 'gemma3-1b', backend: 'ollama', backendModelId: 'gemma3:1b', modality: 'llm', requirements: { diskMb: 815 } },
    { id: 'llama-vllm', backend: 'vllm', backendModelId: 'meta-llama/Llama-3.2-3B', modality: 'llm', requirements: { diskMb: 6000 } },
  ],
  availableModels: [
    { id: 'nomic-embed-text', backend: 'ollama', backendModelId: 'nomic-embed-text', modality: 'embedding', requirements: { diskMb: 300 } },
  ],
  installedCatalogIds: ['gemma3-1b'],
};

const hubAnswer = (status: number, body: unknown, keyPresent = true) =>
  [
    `device-key=${keyPresent ? 'present' : 'missing'}`,
    `onboarding-http=${String(status).padStart(3, '0')}`,
    'onboarding-body-begin',
    JSON.stringify(body),
    'onboarding-body-end',
  ].join('\n');

/** Route each SSH call by the script it carries: the recommendation probe, or a model pull. */
function answerSsh(perHost: Record<string, string>, pullOut = 'model-pull-complete') {
  mocks.sshCapture.mockImplementation(async (target: { host: string }, command: string) => {
    if (command.includes('onboarding-profile')) return ok(perHost[target.host] ?? '');
    return ok(pullOut);
  });
}

function pullsFor(host: string): string[] {
  return mocks.sshCapture.mock.calls
    .filter(([target, command]) => (target as { host: string }).host === host && !(command as string).includes('onboarding-profile'))
    .map(([, command]) => /ollama pull '([^']+)'/.exec(command as string)?.[1] ?? '?');
}

function printed(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

beforeEach(() => {
  process.exitCode = undefined;
  mocks.nodes = [
    { name: 'strix-1', ip: '10.0.0.1' },
    { name: 'a1000', ip: '10.0.0.2' },
  ];
  mocks.sshCapture.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('parsing --models', () => {
  it('reads `recommended` as a mode, not a model', () => {
    const args = parseFleetArgs(['update', '--models', 'recommended']);
    expect(args.recommendModels).toBe(true);
    expect(args.models).toEqual([]);
    expect(parseFleetArgs(['update', '--models=recommended']).recommendModels).toBe(true);
  });

  it('keeps the explicit-list form exactly as it was', () => {
    const args = parseFleetArgs(['update', '--models', 'llama3,qwen3']);
    expect(args.recommendModels).toBe(false);
    expect(args.models).toEqual(['llama3', 'qwen3']);
  });

  it('refuses to mix the mode with names rather than guess which wins', () => {
    expect(() => parseFleetArgs(['update', '--models', 'recommended,llama3'])).toThrow(FleetArgError);
    expect(() => parseFleetArgs(['update', '--models', 'llama3,recommended'])).toThrow(/cannot be combined/);
  });
});

describe('fleet update --models <list>', () => {
  it('pulls the named models plus the platform floor on every node, without asking any Hub', async () => {
    mocks.sshCapture.mockResolvedValue(ok('model-pull-complete'));
    await runFleetCommand(['update', '--execute', '--models', 'llama3']);
    expect(pullsFor('10.0.0.1')).toEqual(['llama3', 'nomic-embed-text']);
    expect(pullsFor('10.0.0.2')).toEqual(['llama3', 'nomic-embed-text']);
    expect(mocks.sshCapture.mock.calls.some(([, command]) => (command as string).includes('onboarding-profile'))).toBe(false);
    expect(printed()).toContain('named on the command line');
    expect(process.exitCode).toBeUndefined();
  });

  it('does not pull the floor twice when the operator already named it', async () => {
    mocks.sshCapture.mockResolvedValue(ok('model-pull-complete'));
    await runFleetCommand(['update', '--execute', '--models', 'nomic-embed-text:latest,llama3', '--nodes', 'a1000']);
    expect(pullsFor('10.0.0.2')).toEqual(['nomic-embed-text:latest', 'llama3']);
  });
});

describe('fleet update --models recommended', () => {
  it("pulls each node's own Hub list, skips what the Hub says is present, and names the source", async () => {
    answerSsh({ '10.0.0.1': hubAnswer(200, PROFILE), '10.0.0.2': hubAnswer(200, PROFILE) });
    await runFleetCommand(['update', '--execute', '--models', 'recommended', '--nodes', 'a1000']);
    // gemma3:1b is present per the Hub's live tag list, so it is reported and not pulled. The vLLM
    // row is not an Ollama tag and never reaches `ollama pull`. The floor is appended.
    expect(pullsFor('10.0.0.2')).toEqual(['qwen3.5:9b', 'nomic-embed-text']);
    const out = printed();
    expect(out).toContain("this node's Hub recommended");
    expect(out).toContain('tier medium');
    expect(out).toContain('gemma3:1b — already present');
    // The floor is in the Hub's available list but not its installed one, so it is pulled too.
    expect(out).toMatch(/2 pulled · 1 already present · 0 failed · ≈ 6\.9 GB fetched/);
    expect(process.exitCode).toBeUndefined();
  });

  it('gives a node whose Hub is unreachable the floor and the reason — never an empty list', async () => {
    answerSsh({ '10.0.0.1': hubAnswer(0, ''), '10.0.0.2': hubAnswer(200, PROFILE) });
    await runFleetCommand(['update', '--execute', '--models', 'recommended']);
    expect(pullsFor('10.0.0.1')).toEqual(['nomic-embed-text']);
    expect(pullsFor('10.0.0.2')).toEqual(['qwen3.5:9b', 'nomic-embed-text']);
    const out = printed();
    expect(out).toContain('floor only');
    expect(out).toContain("the node's Hub did not answer");
    // A Hub that could not be asked is a reason on the report, not a failed run: the pulls succeeded.
    expect(process.exitCode).toBeUndefined();
  });

  it('falls back the same way when SSH itself fails, in the SSH failure vocabulary', async () => {
    mocks.sshCapture.mockImplementation(async (target: { host: string }, command: string) => {
      if (target.host === '10.0.0.1') return { ok: false, out: '', err: 'tailnet policy does not permit you to SSH to this node', code: 255, ms: 5 };
      return ok(command.includes('onboarding-profile') ? hubAnswer(200, PROFILE) : 'model-pull-complete');
    });
    await runFleetCommand(['update', '--execute', '--models', 'recommended']);
    expect(pullsFor('10.0.0.1')).toEqual(['nomic-embed-text']);
    expect(printed()).toContain('the tailnet ACL grants no SSH');
    // The floor pull on that node fails over the same dead SSH, and that failure IS the run's.
    expect(process.exitCode).toBe(1);
  });

  it('keeps 409 unclaimed and 401 rejected apart in what it tells the operator', async () => {
    answerSsh({
      '10.0.0.1': hubAnswer(409, { message: 'AUTH_ERROR_HUB_NOT_CLAIMED', statusCode: 409 }),
      '10.0.0.2': hubAnswer(401, { message: 'SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN', statusCode: 401 }),
    });
    await runFleetCommand(['update', '--models', 'recommended']);
    const out = printed();
    expect(out).toContain('HTTP 409');
    expect(out).toContain('cihub claim');
    expect(out).toContain('HTTP 401');
    expect(out).toContain('rejected the device key');
  });

  it('dry run reads every Hub, prints each list with its provenance, and pulls nothing', async () => {
    answerSsh({ '10.0.0.1': hubAnswer(200, PROFILE), '10.0.0.2': hubAnswer(0, '') });
    await runFleetCommand(['update', '--models', 'recommended']);
    expect(pullsFor('10.0.0.1')).toEqual([]);
    expect(pullsFor('10.0.0.2')).toEqual([]);
    expect(mocks.sshCapture).toHaveBeenCalledTimes(2);
    const out = printed();
    expect(out).toContain('Dry run');
    expect(out).toContain("this node's Hub recommended");
    expect(out).toContain('would pull qwen3.5:9b');
    expect(out).toContain('would keep gemma3:1b');
    expect(out).toContain('platform requirement');
    expect(out).toContain('floor only');
    expect(out).toMatch(/≈ .* to download/);
    expect(process.exitCode).toBeUndefined();
  });

  it('fails the run when a pull fails, and says which model on which node', async () => {
    answerSsh(
      { '10.0.0.1': hubAnswer(200, PROFILE), '10.0.0.2': hubAnswer(200, PROFILE) },
      'pulling manifest\nError: pull model manifest: file does not exist',
    );
    await runFleetCommand(['update', '--execute', '--models', 'recommended', '--nodes', 'strix-1']);
    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/qwen3\.5:9b.*file does not exist/);
  });

  it('emits a per-node JSON report with provenance and per-model outcomes', async () => {
    answerSsh({ '10.0.0.1': hubAnswer(200, PROFILE), '10.0.0.2': hubAnswer(0, '') });
    await runFleetCommand(['update', '--execute', '--models', 'recommended', '--json']);
    const json = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .find((line) => line.trimStart().startsWith('['));
    expect(json).toBeTruthy();
    const report = JSON.parse(json as string) as { node: string; provenance: string; results: { tag: string; outcome: string }[] }[];
    expect(report.map((r) => [r.node, r.provenance])).toEqual([
      ['strix-1', 'hub-recommended'],
      ['a1000', 'floor-only'],
    ]);
    expect(report[0]?.results.map((r) => r.outcome)).toEqual(['pulled', 'already-present', 'pulled']);
  });
});
