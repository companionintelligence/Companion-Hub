/**
 * Where a resident model lives — the `/api/ps` reading and the CPU-resident judgement.
 *
 * Measured 2026-09-21: six Strix Halo nodes served qwen3-coder:30b with `size_vram: 0` — 37.5 tok/s
 * against 75–79 with `OLLAMA_IGPU_ENABLE=1` — while `fleet status` showed every column green. The
 * cases below are that node, the node after the fix, a CPU-only box that is not a finding, a
 * remote reading that cannot flag anything, and the shapes of output the probe can come back with.
 *
 * SSH and HTTP are stubbed with the exact text the remote script prints. Nothing here dials a machine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sshCapture: vi.fn() }));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: mocks.sshCapture,
}));

import {
  CPU_RESIDENT_VRAM_FRACTION,
  describeCpuResident,
  describeResidency,
  judgeOllamaResidency,
  ollamaResidencyScript,
  parseOllamaPsBody,
  parseOllamaResidencyOutput,
  readOllamaResidencies,
  readOllamaResidency,
  readOllamaResidencyOnNode,
  renderResidencyCell,
  RESIDENCY_PROBE_MARKER,
  residencyGpuFromFacts,
} from '../lib/fleet-ollama-residency.js';
import type { HostFacts } from '../lib/fleet-hardware.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

const GIB = 1024 ** 3;
/** qwen3-coder:30b as `/api/ps` reports it: 18.6 GiB. `sizeVram` is the only thing that varies. */
const qwen = (sizeVram: number) =>
  JSON.stringify({
    models: [
      {
        name: 'qwen3-coder:30b',
        model: 'qwen3-coder:30b',
        size: 19975044096,
        digest: 'abc',
        details: { family: 'qwen3moe', parameter_size: '30.5B', quantization_level: 'Q4_K_M' },
        expires_at: '2026-09-22T10:00:00Z',
        size_vram: sizeVram,
        context_length: 65536,
      },
    ],
  });

/** The probe as a Strix Halo node prints it. `gfx_target_version` 110501 is gfx1151, packed. */
const probe = (over: { env?: string; nvidia?: string; amdGfxRaw?: string; body?: string; error?: string } = {}) =>
  [
    RESIDENCY_PROBE_MARKER,
    'ollama-ps-host=0.0.0.0:11434',
    `ollama-ps-env=${over.env ?? 'OLLAMA_HOST=0.0.0.0:11434 OLLAMA_LLM_LIBRARY=vulkan OLLAMA_KEEP_ALIVE=24h'}`,
    `ollama-ps-nvidia=${over.nvidia ?? ''}`,
    `ollama-ps-amd-gfx=${over.amdGfxRaw ?? '110501'}`,
    over.error ? `ollama-ps-error=${over.error}` : `ollama-ps-body=${over.body ?? qwen(0)}`,
  ].join('\n');

const facts = (over: Partial<HostFacts> = {}): HostFacts => ({
  os: 'linux',
  arch: 'x86_64',
  appleSilicon: false,
  docker: { present: true, usable: true },
  gpus: [],
  enginesListening: [11434],
  notes: [],
  ...over,
});
const strixHalo = { vendor: 'amd' as const, gfx: 'gfx1151', reportedVramMib: 2048, gttMib: 62061, driverWorking: true };
const nvidia = { vendor: 'nvidia' as const, name: 'RTX A1000', reportedVramMib: 8192, driverWorking: true };

// ─── The script ────────────────────────────────────────────────────────────────────────────────────

describe('ollamaResidencyScript', () => {
  const script = ollamaResidencyScript();

  it('asks /api/ps at the bind the node resolves for itself, and prints the marker first', () => {
    // Several nodes here bind their tailnet address and answer nothing on loopback; the same host
    // resolution the version probe uses is what keeps this from reading "nothing loaded" on them.
    expect(script).toContain('systemctl show ollama -p Environment');
    expect(script).toContain('http://$host/api/ps');
    expect(script.indexOf(`echo "${RESIDENCY_PROBE_MARKER}"`)).toBeLessThan(script.indexOf('curl'));
  });

  it('reads the merged environment and the GPU on the same round trip, so the reason is in evidence', () => {
    expect(script).toContain('ollama-ps-env=$(systemctl show ollama -p Environment');
    expect(script).toContain('ollama-ps-nvidia=$(nvidia-smi');
    expect(script).toContain('gfx_target_version');
    expect(script).toContain("awk '$2 > 0 {print $2; exit}'");
  });

  it('never exits non-zero, so a silent daemon is not mistaken for a failed SSH session', () => {
    // Shell `exit` statements only — awk's `{print $4; exit}` inside the host resolution is not one.
    const exits = script.split('\n').filter((l) => /(^|;\s)exit(\s|$)/.test(l));
    expect(exits.length).toBeGreaterThan(0);
    for (const line of exits) expect(line).toMatch(/exit 0/);
    expect(script).not.toContain('set -e');
  });
});

// ─── Parsing ───────────────────────────────────────────────────────────────────────────────────────

describe('parseOllamaPsBody', () => {
  it('reads name, size and size_vram from the shape Ollama prints', () => {
    expect(parseOllamaPsBody(qwen(0))).toEqual([{ name: 'qwen3-coder:30b', size: 19975044096, sizeVram: 0, contextLength: 65536 }]);
  });

  it('reads an empty daemon as an empty list, not as unread', () => {
    expect(parseOllamaPsBody('{"models":[]}')).toEqual([]);
  });

  it('returns undefined for anything that is not the shape, never a model', () => {
    expect(parseOllamaPsBody('')).toBeUndefined();
    expect(parseOllamaPsBody('<html>404</html>')).toBeUndefined();
    expect(parseOllamaPsBody('{"error":"x"}')).toBeUndefined();
    expect(parseOllamaPsBody('{"models":[{"size":1}]}')).toEqual([]);
  });
});

describe('parseOllamaResidencyOutput', () => {
  it('reads the models, the two environment keys, and the GPU from a Strix Halo probe', () => {
    const r = parseOllamaResidencyOutput(probe());
    expect(r.host).toBe('0.0.0.0:11434');
    expect(r.models).toEqual([{ name: 'qwen3-coder:30b', size: 19975044096, sizeVram: 0, contextLength: 65536 }]);
    expect(r.env).toEqual({ llmLibrary: 'vulkan', igpuEnable: undefined });
    expect(r.gpu).toEqual({ present: true, integratedAmd: true, label: 'amd/gfx1151' });
    expect(r.reason).toBeUndefined();
  });

  it('reads OLLAMA_IGPU_ENABLE once the managed bind file carries it', () => {
    const r = parseOllamaResidencyOutput(
      probe({ env: 'OLLAMA_HOST=0.0.0.0:11434 OLLAMA_LLM_LIBRARY=vulkan OLLAMA_IGPU_ENABLE=1', body: qwen(19975044096) }),
    );
    expect(r.env).toEqual({ llmLibrary: 'vulkan', igpuEnable: '1' });
    expect(r.models?.[0]?.sizeVram).toBe(19975044096);
  });

  it('tells an NVIDIA box, a CPU-only box and a discrete AMD card apart', () => {
    expect(parseOllamaResidencyOutput(probe({ nvidia: 'NVIDIA RTX A1000', amdGfxRaw: '' })).gpu).toEqual({
      present: true,
      integratedAmd: false,
      label: 'nvidia',
    });
    expect(parseOllamaResidencyOutput(probe({ amdGfxRaw: '' })).gpu).toEqual({ present: false, integratedAmd: false, label: 'none' });
    // 110000 is gfx1100 — an RX 7900, discrete.
    expect(parseOllamaResidencyOutput(probe({ amdGfxRaw: '110000' })).gpu).toEqual({ present: true, integratedAmd: false, label: 'amd/gfx1100' });
  });

  it('turns the error line into a reason with no models, keeping the environment it did read', () => {
    const r = parseOllamaResidencyOutput(probe({ error: 'nothing answered at 0.0.0.0:11434/api/ps' }));
    expect(r.models).toBeUndefined();
    expect(r.reason).toBe('nothing answered at 0.0.0.0:11434/api/ps');
    expect(r.env?.llmLibrary).toBe('vulkan');
  });

  it('never invents a reading from empty, foreign or unparseable output', () => {
    expect(parseOllamaResidencyOutput('').reason).toBe('the residency probe printed nothing');
    expect(parseOllamaResidencyOutput('bind_probe=1\nunit_file=none').reason).toMatch(/^unrecognised probe output/);
    const bad = parseOllamaResidencyOutput(probe({ body: '<html>' }));
    expect(bad.models).toBeUndefined();
    expect(bad.reason).toMatch(/^unparseable \/api\/ps body/);
  });
});

// ─── The judgement ─────────────────────────────────────────────────────────────────────────────────

describe('judgeOllamaResidency', () => {
  it('names the vulkan/iGPU trap on a Strix Halo node with size_vram 0 and the key unset, with the fix', () => {
    const [f, ...rest] = judgeOllamaResidency(parseOllamaResidencyOutput(probe()));
    expect(rest).toEqual([]);
    expect(f?.cause).toBe('vulkan-without-igpu');
    expect(f?.why).toBe(
      'size_vram 0 of 18.6 GiB: OLLAMA_LLM_LIBRARY=vulkan with OLLAMA_IGPU_ENABLE unset — Ollama drops an integrated GPU unless OLLAMA_IGPU_ENABLE=1, so the model loaded on the CPU',
    );
    expect(f?.fix).toContain('cihub fleet backends --backends ollama --execute');
    expect(describeCpuResident(f as NonNullable<typeof f>)).toMatch(/^qwen3-coder:30b resident on CPU — size_vram 0 of 18.6 GiB/);
  });

  it('names the operator override when the key is an explicit 0, and points at the runtime flag', () => {
    const [f] = judgeOllamaResidency(parseOllamaResidencyOutput(probe({ env: 'OLLAMA_LLM_LIBRARY=vulkan OLLAMA_IGPU_ENABLE=0' })));
    expect(f?.cause).toBe('vulkan-without-igpu');
    expect(f?.why).toContain('OLLAMA_IGPU_ENABLE=0');
    expect(f?.fix).toContain('--ollama-igpu unset');
  });

  it('finds nothing on the same node once the model is in VRAM', () => {
    const fixed = probe({ env: 'OLLAMA_LLM_LIBRARY=vulkan OLLAMA_IGPU_ENABLE=1', body: qwen(19975044096) });
    expect(judgeOllamaResidency(parseOllamaResidencyOutput(fixed))).toEqual([]);
  });

  it('still flags size_vram 0 with the key set, but as measured-not-explained, pointing at the journal', () => {
    const [f] = judgeOllamaResidency(parseOllamaResidencyOutput(probe({ env: 'OLLAMA_LLM_LIBRARY=vulkan OLLAMA_IGPU_ENABLE=1' })));
    expect(f?.cause).toBe('unknown');
    expect(f?.why).toContain('journalctl -u ollama');
    expect(f?.fix).toBeUndefined();
  });

  it('does not blame the iGPU key on a discrete card or an NVIDIA box: the combination needs an integrated part', () => {
    const [amd] = judgeOllamaResidency(parseOllamaResidencyOutput(probe({ amdGfxRaw: '110000' })));
    expect(amd?.cause).toBe('unknown');
    const [nv] = judgeOllamaResidency(parseOllamaResidencyOutput(probe({ nvidia: 'RTX A1000', amdGfxRaw: '', env: 'OLLAMA_HOST=0.0.0.0:11434' })));
    expect(nv?.cause).toBe('unknown');
    expect(nv?.why).toContain('(nvidia)');
  });

  it('is not a finding on a CPU-only box, nor on a reading that never saw the GPU', () => {
    expect(judgeOllamaResidency(parseOllamaResidencyOutput(probe({ amdGfxRaw: '' })))).toEqual([]);
    // A remote read: models only, no gpu, no env.
    expect(judgeOllamaResidency({ models: [{ name: 'qwen3-coder:30b', size: 10 * GIB, sizeVram: 0 }] })).toEqual([]);
  });

  it('flags a partial offload that leaves most of the model in system memory, and not one that does not', () => {
    const gpu = { present: true, integratedAmd: false, label: 'nvidia' };
    const at = (fraction: number) =>
      judgeOllamaResidency({ gpu, models: [{ name: 'm', size: 10 * GIB, sizeVram: Math.round(10 * GIB * fraction) }] });
    expect(at(0.3)).toHaveLength(1);
    expect(at(0.3)[0]?.why).toMatch(/^size_vram 3\.0 GiB of 10\.0 GiB/);
    expect(at(CPU_RESIDENT_VRAM_FRACTION)).toEqual([]);
    expect(at(1)).toEqual([]);
  });

  it('skips a model whose size is unknown rather than dividing by it', () => {
    expect(
      judgeOllamaResidency({ gpu: { present: true, integratedAmd: true, label: 'amd/gfx1151' }, models: [{ name: 'm', size: 0, sizeVram: 0 }] }),
    ).toEqual([]);
  });
});

describe('residencyGpuFromFacts', () => {
  it('takes the GPU half from the hardware facts, distinguishing present from working', () => {
    expect(residencyGpuFromFacts(facts({ gpus: [strixHalo] }))).toEqual({ present: true, integratedAmd: true, label: 'amd/gfx1151' });
    expect(residencyGpuFromFacts(facts({ gpus: [nvidia] }))).toEqual({ present: true, integratedAmd: false, label: 'nvidia' });
    expect(residencyGpuFromFacts(facts())).toEqual({ present: false, integratedAmd: false, label: 'none' });
    // The card that ran a node CPU-only for weeks: on the bus, driver dead. Not a GPU for this purpose.
    const dead = { vendor: 'nvidia' as const, name: 'RTX 3070', driverWorking: false };
    expect(residencyGpuFromFacts(facts({ gpus: [dead] })).present).toBe(false);
  });
});

// ─── Rendering ─────────────────────────────────────────────────────────────────────────────────────

describe('describeResidency and renderResidencyCell', () => {
  it('prints the inventory line: none, on the GPU, on the CPU, or partly offloaded', () => {
    expect(describeResidency({ models: [] })).toBe('resident: none');
    expect(describeResidency({ models: [{ name: 'a', size: 10 * GIB, sizeVram: 10 * GIB }] })).toBe('resident: a (10.0 GiB, GPU)');
    expect(describeResidency({ models: [{ name: 'a', size: 10 * GIB, sizeVram: 0 }] })).toBe('resident: a (10.0 GiB, CPU)');
    expect(describeResidency({ models: [{ name: 'a', size: 10 * GIB, sizeVram: 3 * GIB }] })).toBe('resident: a (10.0 GiB, 30% VRAM)');
    expect(describeResidency({ reason: 'ssh timeout' })).toBe('resident: unread — ssh timeout');
  });

  it('renders the status cell: names, a CPU marker in yellow, a dash for nothing, ? for unread', () => {
    const models = [
      { name: 'qwen3-coder:30b', size: 10 * GIB, sizeVram: 0 },
      { name: 'nomic-embed-text', size: GIB, sizeVram: GIB },
    ];
    const findings = judgeOllamaResidency({ models, gpu: { present: true, integratedAmd: false, label: 'nvidia' } });
    expect(renderResidencyCell({ models }, findings)).toEqual({ text: 'qwen3-coder:30b ⚠ CPU, nomic-embed-text', tone: 'yellow' });
    expect(renderResidencyCell({ models: [models[1] as (typeof models)[number]] }, [])).toEqual({ text: 'nomic-embed-text', tone: undefined });
    expect(renderResidencyCell({ models: [] }, [])).toEqual({ text: '—', tone: undefined });
    expect(renderResidencyCell({ reason: 'ssh timeout' }, [])).toEqual({ text: '?', tone: 'dim' });
  });
});

// ─── Reading ───────────────────────────────────────────────────────────────────────────────────────

describe('reading a node', () => {
  beforeEach(() => {
    mocks.sshCapture.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs the script over SSH under its own heredoc and parses what came back', async () => {
    mocks.sshCapture.mockResolvedValue({ ok: true, out: probe(), err: '', code: 0, ms: 3 });
    const r = await readOllamaResidencyOnNode({ host: '100.64.0.9', user: 'ci' });
    expect(mocks.sshCapture.mock.calls[0]?.[1]).toContain("bash <<'CIHUB_OLLAMA_PS_EOF'");
    expect(r.models).toHaveLength(1);
    expect(r.gpu?.integratedAmd).toBe(true);
  });

  it('reports an SSH failure as the reason, never as nothing loaded', async () => {
    mocks.sshCapture.mockResolvedValue({
      ok: false,
      out: '',
      err: 'ssh: connect to host 100.64.0.9 port 22: Connection timed out',
      code: 255,
      ms: 3,
    });
    const r = await readOllamaResidencyOnNode({ host: '100.64.0.9' });
    expect(r.models).toBeUndefined();
    expect(r.reason).toMatch(/^ssh /);
  });

  it('reads on the node when SSH is available, and from here only when it was not attempted', async () => {
    mocks.sshCapture.mockResolvedValue({ ok: true, out: probe(), err: '', code: 0, ms: 3 });
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(qwen(19975044096), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const onNode = await readOllamaResidency({ node: { name: 'core-4', ip: '100.64.0.9' }, sshOk: true });
    expect(onNode.source).toBe('node');
    expect(fetchMock).not.toHaveBeenCalled();

    const remote = await readOllamaResidency({ node: { name: 'beta-red', ip: '100.64.0.7' }, sshOk: false, sshFailure: 'acl-denied' });
    expect(remote.source).toBe('remote');
    expect(remote.models?.[0]?.sizeVram).toBe(19975044096);
    // No GPU, no environment from a remote read: it lists, it never flags.
    expect(remote.gpu).toBeUndefined();
    expect(judgeOllamaResidency(remote)).toEqual([]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://100.64.0.7:11434/api/ps');
  });

  it('names both refusals when a node without SSH does not answer from here either', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 502 })),
    );
    const r = await readOllamaResidency({ node: { name: 'beta-red', ip: '100.64.0.7' }, sshOk: false, sshFailure: 'acl-denied' });
    expect(r.models).toBeUndefined();
    expect(r.reason).toBe('ssh acl-denied; :11434/api/ps did not answer from here');
  });

  it('reads every node, bounded, keeping input order', async () => {
    mocks.sshCapture.mockImplementation(async (t: { host: string }) => ({
      ok: true,
      out: t.host === '10.0.0.2' ? probe({ body: qwen(19975044096), env: 'OLLAMA_LLM_LIBRARY=vulkan OLLAMA_IGPU_ENABLE=1' }) : probe(),
      err: '',
      code: 0,
      ms: 1,
    }));
    const out = await readOllamaResidencies(
      [
        { node: { name: 'a', ip: '10.0.0.1' }, sshOk: true },
        { node: { name: 'b', ip: '10.0.0.2' }, sshOk: true },
      ],
      { concurrency: 1 },
    );
    expect(out.map((r) => [r.node, r.models?.[0]?.sizeVram])).toEqual([
      ['a', 0],
      ['b', 19975044096],
    ]);
  });
});
