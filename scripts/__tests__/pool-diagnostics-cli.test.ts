import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.fn();
const parseEnvFile = vi.fn();
const existsSync = vi.fn();
const statSync = vi.fn();
const dnsLookup = vi.fn();
const readHubApiKey = vi.fn();
const runBridgeDoctorSection = vi.fn();
const isHubContainerRunning = vi.fn();
const resolveHubContainerName = vi.fn();
const probeHostPort = vi.fn();

vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => spawnSync(...args) }));
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSync(...args),
  statSync: (...args: unknown[]) => statSync(...args),
}));
vi.mock('node:dns', () => {
  const lookup = (...args: unknown[]) => dnsLookup(...args);
  return { default: { lookup }, lookup };
});
vi.mock('../env-file', () => ({ parseEnvFile: (...args: unknown[]) => parseEnvFile(...args) }));
vi.mock('../public-web-cli', () => ({ readHubApiKey: (...args: unknown[]) => readHubApiKey(...args) }));
vi.mock('../bridge-diagnostics-cli', () => ({
  runBridgeDoctorSection: (...args: unknown[]) => runBridgeDoctorSection(...args),
  isHubContainerRunning: (...args: unknown[]) => isHubContainerRunning(...args),
  resolveHubContainerName: (...args: unknown[]) => resolveHubContainerName(...args),
  probeHostPort: (...args: unknown[]) => probeHostPort(...args),
}));

const {
  checkBackendDns,
  checkCapabilityBudget,
  checkDataDirOwnership,
  checkEnvFoundation,
  checkHubHealth,
  checkNonStreamingHeadroom,
  checkPoolProtocol,
  checkTailnet,
  checkTailscaleServe,
  countPoolIssues,
  formatPoolCheckLines,
  modelParameterBillions,
  parseTailscaleStatus,
  pathWritableBy,
  pickLargestLoadedModel,
  probeDnsFromContainer,
  resolveBackendUrlSpecs,
  runPoolDoctorSection,
  summarisePoolChecks,
} = await import('../pool-diagnostics-cli');

const { stripAnsi } = await import('../lib/cli-ui');

/** An `HttpProbe`, shaped the way `timedFetch` returns one. */
function probe(overrides: Partial<{ ok: boolean; status: number | null; ms: number; body: string; error: string | null }> = {}) {
  return { ok: true, status: 200, ms: 12, body: '{}', error: null, ...overrides } as never;
}

function text(lines: string[]): string {
  return stripAnsi(lines.join('\n'));
}

const NO_TAILSCALE = { available: false, backendState: null, dnsName: null };
// Placeholder tailnet name only — docs/README.md tip-scrub policy.
const SELF = { available: true, backendState: 'Running', dnsName: 'hub-a.example-tailnet.ts.net' };

beforeEach(() => {
  spawnSync.mockReset();
  parseEnvFile.mockReset().mockReturnValue({});
  existsSync.mockReset().mockReturnValue(false);
  statSync.mockReset();
  dnsLookup.mockReset();
  readHubApiKey.mockReset().mockReturnValue(undefined);
  runBridgeDoctorSection.mockReset().mockResolvedValue({ lines: ['Docker bridge  skipped'], issueCount: 0, remediationCommands: [] });
  isHubContainerRunning.mockReset().mockReturnValue(false);
  resolveHubContainerName.mockReset().mockReturnValue(undefined);
  probeHostPort.mockReset().mockResolvedValue(false);
});

// ─── A1 ──────────────────────────────────────────────────────────────────────

describe('A1 env foundation', () => {
  const foundation = (overrides: Record<string, unknown> = {}) => ({
    envFileName: '.env.prod',
    exists: true,
    apiPort: 5002,
    rootFolderHost: '/data/hub',
    containerUid: 1000,
    containerGid: 1000,
    ...overrides,
  });

  it('fails with appendable lines when the env file is absent entirely', () => {
    const check = checkEnvFoundation(foundation({ exists: false, apiPort: null, rootFolderHost: null }) as never, '/default/root');
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('does not exist');
    expect(check.commands).toEqual(["printf 'API_PORT=%s\\n' 5002 >> .env.prod", "printf 'ROOT_FOLDER_HOST=%s\\n' '/default/root' >> .env.prod"]);
  });

  it('fails on the stub env four fleet nodes shipped with, naming both missing keys', () => {
    const check = checkEnvFoundation(foundation({ apiPort: null, rootFolderHost: null }) as never, '/default/root');
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('API_PORT');
    expect(check.detail).toContain('ROOT_FOLDER_HOST');
    expect(check.commands).toHaveLength(2);
  });

  it('reports only the key that is actually missing', () => {
    const check = checkEnvFoundation(foundation({ rootFolderHost: null }) as never, '/default/root');
    expect(check.detail).toContain('ROOT_FOLDER_HOST');
    expect(check.detail).not.toContain('API_PORT,');
    expect(check.commands).toEqual(["printf 'ROOT_FOLDER_HOST=%s\\n' '/default/root' >> .env.prod"]);
  });

  it('passes and echoes both values back when the env file is complete', () => {
    const check = checkEnvFoundation(foundation() as never, '/default/root');
    expect(check.verdict).toBe('ok');
    expect(check.detail).toContain('API_PORT=5002');
    expect(check.detail).toContain('/data/hub');
  });
});

// ─── A2 ──────────────────────────────────────────────────────────────────────

describe('A2 hub health', () => {
  it('tells "nothing is listening" apart from "listening but unhealthy"', () => {
    const dead = checkHubHealth(probe({ ok: false, status: null, error: 'fetch failed' }), 'http://127.0.0.1:5002', false, 'prod');
    expect(dead.detail).toContain('nothing is listening');
    expect(dead.commands).toEqual(['cihub up prod']);

    const wrong = checkHubHealth(probe({ ok: false, status: 503 }), 'http://127.0.0.1:5002', true, 'prod');
    expect(wrong.detail).toContain('503');
    expect(wrong.commands).toEqual(['cihub logs prod']);
  });

  it('passes with the measured latency when the Hub answers', () => {
    expect(checkHubHealth(probe({ ms: 21 }), 'http://127.0.0.1:5002', true, 'prod')).toMatchObject({ verdict: 'ok' });
  });
});

// ─── A3 ──────────────────────────────────────────────────────────────────────

describe('A3 pool protocol', () => {
  it('reads a 404 as a build that predates Hub Pool', () => {
    const check = checkPoolProtocol(probe({ ok: false, status: 404 }), 'http://127.0.0.1:5002');
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('predates Hub Pool');
    expect(check.commands).toEqual(['cihub update']);
  });

  it('reads 200 with no poolProtocol field as protocol 1, not as success', () => {
    const check = checkPoolProtocol(probe({ body: JSON.stringify({ isCiHub: true }) }), 'http://127.0.0.1:5002');
    expect(check.verdict).toBe('warn');
    expect(check.detail).toContain('pool protocol 1');
    expect(text(check.notes ?? [])).toContain('pairing by address');
  });

  it('reports the protocol number when the field is present', () => {
    const check = checkPoolProtocol(probe({ body: JSON.stringify({ isCiHub: true, poolProtocol: 2 }) }), 'http://127.0.0.1:5002');
    expect(check.verdict).toBe('ok');
    expect(check.detail).toBe('pool protocol 2');
  });

  it('does not claim a build has no Hub Pool when the Hub simply did not answer', () => {
    const check = checkPoolProtocol(probe({ ok: false, status: null, error: 'fetch failed' }), 'http://127.0.0.1:5002');
    expect(check.verdict).toBe('unknown');
  });
});

// ─── A4 ──────────────────────────────────────────────────────────────────────

describe('A4 data dir ownership', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({ name: 'state', present: true, uid: 1000, gid: 1000, mode: 0o755, ...overrides });

  it('decides writability from owner, group and other bits', () => {
    expect(pathWritableBy(entry() as never, 1000, 1000)).toBe(true);
    // The real failure: Docker created it root:root 0755 and the container runs as 1000.
    expect(pathWritableBy(entry({ uid: 0, gid: 0 }) as never, 1000, 1000)).toBe(false);
    expect(pathWritableBy(entry({ uid: 0, gid: 1000, mode: 0o775 }) as never, 1000, 1000)).toBe(true);
    expect(pathWritableBy(entry({ uid: 0, gid: 0, mode: 0o777 }) as never, 1000, 1000)).toBe(true);
    expect(pathWritableBy(entry({ uid: 1000, mode: 0o555 }) as never, 1000, 1000)).toBe(false);
    expect(pathWritableBy(entry({ present: false, mode: null }) as never, 1000, 1000)).toBe(false);
    // A container running as root writes anywhere, so a root-owned tree is not a finding for it.
    expect(pathWritableBy(entry({ uid: 0, gid: 0 }) as never, 0, 0)).toBe(true);
  });

  it('fails on the root:root state dir that kills the Hub with EACCES', () => {
    const check = checkDataDirOwnership([entry({ uid: 0, gid: 0 }) as never], '/data/hub', 1000, 1000);
    expect(check.verdict).toBe('fail');
    expect(text(check.notes ?? [])).toContain('settings.json');
    expect(check.commands).toEqual(['sudo chown -R 1000:1000 /data/hub']);
  });

  it('warns rather than fails when dirs are merely absent, and says why that becomes the failure', () => {
    const check = checkDataDirOwnership([entry({ present: false, uid: null, gid: null, mode: null }) as never], '/data/hub', 1000, 1000);
    expect(check.verdict).toBe('warn');
    expect(text(check.notes ?? [])).toContain('root:root');
  });

  it('passes a tree the container user owns', () => {
    expect(checkDataDirOwnership([entry() as never], '/data/hub', 1000, 1000).verdict).toBe('ok');
  });
});

// ─── B ───────────────────────────────────────────────────────────────────────

describe('B tailnet reachability', () => {
  it('strips the trailing dot off the MagicDNS name', () => {
    const parsed = parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'hub-a.example-tailnet.ts.net.' } }));
    expect(parsed).toEqual({ available: true, backendState: 'Running', dnsName: 'hub-a.example-tailnet.ts.net' });
  });

  it('cannot determine the tailnet with no CLI, and does not call that a failure', () => {
    const check = checkTailnet(NO_TAILSCALE as never);
    expect(check.verdict).toBe('unknown');
    expect(countPoolIssues([check])).toBe(0);
  });

  it('fails a disconnected tailnet and an unnamed node separately', () => {
    expect(checkTailnet({ available: true, backendState: 'Stopped', dnsName: null } as never)).toMatchObject({
      verdict: 'fail',
      commands: ['sudo tailscale up'],
    });
    const unnamed = checkTailnet({ available: true, backendState: 'Running', dnsName: null } as never);
    expect(unnamed.verdict).toBe('fail');
    expect(text(unnamed.notes ?? [])).toContain('no fallback');
  });

  it('prints the operator-grant + serve remediation verbatim, bound to the real API port', () => {
    const check = checkTailscaleServe(probe({ ok: false, status: null, error: 'fetch failed' }), SELF as never, 5010, true, {
      configured: false,
      publishesHub: false,
    });
    expect(check.verdict).toBe('fail');
    expect(check.commands).toEqual(['sudo tailscale set --operator=$USER && tailscale serve --bg --yes --https=443 http://localhost:5010']);
    expect(check.detail).toContain('no `tailscale serve` config');
  });

  /**
   * The self-probe cannot succeed even on a healthy node: `tailscale serve` listens for tailnet
   * peers, and a request to our own MagicDNS name does not loop back through it. Measured — the same
   * URL answered 200 from a peer and failed outright from the node itself. Before this, B2 reported
   * a working node as totally unreachable and printed a fix the operator had already applied.
   */
  it('does not fail a healthy node just because it cannot reach its own serve listener', () => {
    const check = checkTailscaleServe(probe({ ok: false, status: null, error: 'fetch failed' }), SELF as never, 5002, true, {
      configured: true,
      publishesHub: true,
    });
    expect(check.verdict).toBe('ok');
    expect(check.detail).toContain('serve publishes');
    expect(check.commands).toBeUndefined();
  });

  it('still fails when serve is configured but publishes something other than the Hub', () => {
    const check = checkTailscaleServe(probe({ ok: false, status: null, error: 'fetch failed' }), SELF as never, 5002, true, {
      configured: true,
      publishesHub: false,
    });
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('does not publish this Hub');
  });

  it('passes when serve publishes /identify, and says the first attempt waited on the cert', () => {
    const check = checkTailscaleServe(probe({ ms: 240 }), SELF as never, 5002, true, { configured: true, publishesHub: true });
    expect(check.verdict).toBe('ok');
    expect(check.detail).toContain('cert issuance');
  });
});

// ─── C1 ──────────────────────────────────────────────────────────────────────

describe('C1 capabilities budget', () => {
  const perBackend = [
    { backend: 'ollama', ms: 120, ok: true, detail: '8 model(s)' },
    { backend: 'mtplx', ms: 5010, ok: false, detail: 'no answer' },
  ];

  it('fails over the 8s peer probe budget and names the slowest backend', () => {
    // 10.02s: the figure measured on the node that went `unreachable` fleet-wide.
    const check = checkCapabilityBudget(10_020, ['getStatus() 10020ms'], perBackend, true);
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('10020ms');
    expect(check.detail).toContain('OVER');
    const notes = text(check.notes ?? []);
    expect(notes).toContain('mtplx');
    expect(notes).toContain('unreachable');
  });

  it('warns inside the budget but under 2x margin', () => {
    expect(checkCapabilityBudget(5_000, [], [], true).verdict).toBe('warn');
    expect(checkCapabilityBudget(4_000, [], [], true).verdict).toBe('warn');
  });

  it('passes with margin, and still shows the breakdown', () => {
    const check = checkCapabilityBudget(21, ['getStatus() 21ms'], perBackend, true);
    expect(check.verdict).toBe('ok');
    expect(text(check.notes ?? [])).toContain('ollama');
  });

  it('says so when only one of the two concurrent fan-outs could be measured', () => {
    expect(text(checkCapabilityBudget(21, [], [], false).notes ?? [])).toContain('at least this slow');
    expect(text(checkCapabilityBudget(21, [], [], true).notes ?? [])).not.toContain('at least this slow');
  });
});

// ─── C2 ──────────────────────────────────────────────────────────────────────

describe('C2 backend DNS', () => {
  it('reads the backend URL vars, with SPECULATIVE_INFERENCE_URL winning over LUCEBOX_URL', () => {
    const specs = resolveBackendUrlSpecs({
      OLLAMA_URL: 'http://127.0.0.1:11434',
      MTPLX_URL: 'http://mtplx:8000',
      LUCEBOX_URL: 'http://lucebox:8080',
      SPECULATIVE_INFERENCE_URL: 'http://spec:8080',
      VLLM_URL: 'not a url',
    });
    expect(specs.map((spec) => [spec.variable, spec.hostname, spec.isIpLiteral, spec.malformed])).toEqual([
      ['OLLAMA_URL', '127.0.0.1', true, false],
      ['VLLM_URL', null, false, true],
      ['MTPLX_URL', 'mtplx', false, false],
      ['SPECULATIVE_INFERENCE_URL', 'spec', false, false],
    ]);
  });

  it('fails a lookup that BLOCKS, and prints both halves of the dns_opt fix', () => {
    const specs = resolveBackendUrlSpecs({ MTPLX_URL: 'http://mtplx:8000' });
    const check = checkBackendDns(specs, [{ host: 'mtplx', ms: 5_010, code: 'EAI_AGAIN' }], 'container');
    expect(check.verdict).toBe('fail');
    const notes = text(check.notes ?? []);
    expect(notes).toContain('blocks then fails EAI_AGAIN');
    expect(notes).toContain('MTPLX_URL=http://127.0.0.1:1');
    expect(notes).toContain('attempts:5');
    expect(notes).toContain('timeout:2');
  });

  it('treats a fast failure as a real finding from the container and undecidable from the host', () => {
    const specs = resolveBackendUrlSpecs({ MTPLX_URL: 'http://mtplx:8000' });
    const results = [{ host: 'mtplx', ms: 3, code: 'EAI_AGAIN' }];
    expect(checkBackendDns(specs, results, 'container').verdict).toBe('fail');

    const fromHost = checkBackendDns(specs, results, 'host');
    expect(fromHost.verdict).toBe('unknown');
    expect(countPoolIssues([fromHost])).toBe(0);
    expect(text(fromHost.notes ?? [])).toContain('undecidable');
  });

  it('fails a slow lookup even from the host, because a block costs the budget from any vantage', () => {
    const specs = resolveBackendUrlSpecs({ MTPLX_URL: 'http://mtplx:8000' });
    expect(checkBackendDns(specs, [{ host: 'mtplx', ms: 5_010, code: 'EAI_AGAIN' }], 'host').verdict).toBe('fail');
  });

  it('needs no lookup for an IP literal, and passes a name that resolves fast', () => {
    const specs = resolveBackendUrlSpecs({ OLLAMA_URL: 'http://127.0.0.1:11434', MTPLX_URL: 'http://mtplx:8000' });
    const check = checkBackendDns(specs, [{ host: 'mtplx', ms: 4, code: null }], 'container');
    expect(check.verdict).toBe('ok');
    expect(text(check.notes ?? [])).toContain('IP literal, no lookup');
  });

  it('fails a variable that is not a URL at all', () => {
    expect(checkBackendDns(resolveBackendUrlSpecs({ VLLM_URL: 'nope' }), [], 'container').verdict).toBe('fail');
  });

  it('probes the container with dns.lookup — never curl, never getent', () => {
    resolveHubContainerName.mockReturnValue('ci-hub');
    spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify([{ host: 'mtplx', ms: 5010, code: 'EAI_AGAIN' }]) });

    expect(probeDnsFromContainer(['mtplx'])).toEqual([{ host: 'mtplx', ms: 5010, code: 'EAI_AGAIN' }]);

    const [command, args] = spawnSync.mock.calls[0] as [string, string[]];
    const script = args[args.length - 1] as string;
    expect(command).toBe('docker');
    expect(args.slice(0, 4)).toEqual(['exec', 'ci-hub', 'node', '-e']);
    // The crux: curl fails instantly on an unresolvable compose name while getaddrinfo blocks ~5s,
    // so a curl- or getent-based probe cannot see this bug at all.
    expect(script).toContain('dns.lookup');
    expect(script).not.toContain('curl');
    expect(script).not.toContain('getent');
  });

  it('returns null rather than a verdict when there is no container to probe from', () => {
    resolveHubContainerName.mockReturnValue(undefined);
    expect(probeDnsFromContainer(['mtplx'])).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

// ─── C3 ──────────────────────────────────────────────────────────────────────

describe('C3 non-streaming headroom', () => {
  it('ranks models by parameter count off the id', () => {
    expect(modelParameterBillions('gemma3:27b')).toBe(27);
    expect(modelParameterBillions('llama3.2:3b')).toBe(3);
    expect(modelParameterBillions('some-model')).toBe(0);
  });

  it('picks the heaviest model that is actually loaded', () => {
    const models = [
      { id: 'llama3.2:3b', state: 'loaded', local: true },
      { id: 'gemma3:27b', state: 'loaded', local: true },
      { id: 'qwen:72b', state: 'available', local: true },
    ];
    expect(pickLargestLoadedModel(models as never)?.id).toBe('gemma3:27b');
    expect(pickLargestLoadedModel([])).toBeNull();
  });

  it('is skipped by default, and says it costs GPU time', () => {
    const check = checkNonStreamingHeadroom(null, null, { pooled: false, servedBy: null });
    expect(check.verdict).toBe('skipped');
    expect(check.detail).toContain('--check-latency');
    expect(countPoolIssues([check])).toBe(0);
  });

  it('fails past the 15s peer connect timeout and explains the streaming asymmetry', () => {
    const check = checkNonStreamingHeadroom(probe({ ms: 16_400 }), { id: 'gemma3:27b' } as never, { pooled: false, servedBy: 'local' });
    expect(check.verdict).toBe('fail');
    expect(check.detail).toContain('OVER the 15000ms');
    expect(text(check.notes ?? [])).toContain('streaming');
  });

  it('refuses to attribute a pooled answer to this node', () => {
    const check = checkNonStreamingHeadroom(probe({ ms: 900 }), { id: 'gemma3:27b' } as never, { pooled: true, servedBy: 'hub-b' });
    expect(check.verdict).toBe('unknown');
    expect(check.detail).toContain('may have been pooled');
  });

  it('passes a fast local answer', () => {
    expect(checkNonStreamingHeadroom(probe({ ms: 900 }), { id: 'gemma3:27b' } as never, { pooled: false, servedBy: 'local' }).verdict).toBe('ok');
  });
});

// ─── rendering / counting ────────────────────────────────────────────────────

describe('rendering', () => {
  it('counts only decided failures as issues', () => {
    const checks = [
      { id: 'A1', label: 'a', verdict: 'fail' as const, detail: '' },
      { id: 'A2', label: 'b', verdict: 'warn' as const, detail: '' },
      { id: 'A3', label: 'c', verdict: 'unknown' as const, detail: '' },
      { id: 'A4', label: 'd', verdict: 'skipped' as const, detail: '' },
      { id: 'B1', label: 'e', verdict: 'ok' as const, detail: '' },
    ];
    expect(countPoolIssues(checks)).toBe(2);
    expect(summarisePoolChecks(checks)).toBe('1 failed, 1 warned, 1 undetermined, 1 skipped');
    expect(summarisePoolChecks([checks[4] as never])).toBe('all 1 checks passed');
  });

  it('renders the id, the label and every remediation command', () => {
    const rendered = text(
      formatPoolCheckLines([{ id: 'C2', label: 'Backend DNS', verdict: 'fail', detail: 'boom', notes: ['why'], commands: ['fix it'] }]),
    );
    expect(rendered).toContain('C2 Backend DNS');
    expect(rendered).toContain('boom');
    expect(rendered).toContain('why');
    expect(rendered).toContain('$ fix it');
  });
});

// ─── whole run ───────────────────────────────────────────────────────────────

describe('runPoolDoctorSection', () => {
  it('produces a full report on a machine with no Docker, no Tailscale and no Hub', async () => {
    // Nothing answers: fetch rejects, tailscale is missing, no container, no env file.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    spawnSync.mockReturnValue({ status: 1, stdout: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    const rendered = text(section.lines);

    for (const id of ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'C1', 'C2', 'C3']) expect(rendered).toContain(id);
    expect(rendered).toContain('Hub Pool preflight');
    // A reported reason ("Error: fetch failed") is the point; a stack trace is the failure mode.
    expect(rendered).not.toContain('    at ');
    expect(rendered).not.toContain('unavailable (');
    expect(section.remediationCommands).toContain('cihub up prod');
    vi.unstubAllGlobals();
  });

  it('degrades to a single line instead of throwing when a probe blows up', async () => {
    // parseEnvFile is reached before any probe, so this stands in for an unexpected internal fault.
    parseEnvFile.mockImplementation(() => {
      throw new Error('kaboom');
    });
    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    expect(section.lines).toHaveLength(1);
    expect(section.lines[0]).toContain('unavailable (kaboom)');
    expect(section.issueCount).toBe(0);
  });

  it('never prints the operator key it used to reach authenticated routes', async () => {
    const secret = 'cihub_super_secret_device_key';
    readHubApiKey.mockReturnValue(secret);
    parseEnvFile.mockReturnValue({ API_PORT: '5002', ROOT_FOLDER_HOST: '/data/hub' });
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ uid: 1000, gid: 1000, mode: 0o40755 });
    probeHostPort.mockResolvedValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ isCiHub: true, poolProtocol: 2, data: [] }) }),
    );
    spawnSync.mockReturnValue({ status: 1, stdout: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    expect(text(section.lines)).not.toContain(secret);
    expect(section.remediationCommands.join(' ')).not.toContain(secret);
    // ...and it did authenticate with it.
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const authed = calls.filter(([, init]) => new Headers(init?.headers).get('Authorization') === `Bearer ${secret}`);
    expect(authed.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('folds the bridge section in rather than reimplementing it', async () => {
    runBridgeDoctorSection.mockResolvedValue({
      lines: ['Docker bridge            1 blocked'],
      issueCount: 1,
      remediationCommands: ['sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 11434 proto tcp'],
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    spawnSync.mockReturnValue({ status: 1, stdout: '' });

    const section = await runPoolDoctorSection('.env.prod', { env: 'prod' });
    expect(runBridgeDoctorSection).toHaveBeenCalledWith('.env.prod');
    expect(text(section.lines)).toContain('Docker bridge            1 blocked');
    expect(section.remediationCommands).toContain('sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 11434 proto tcp');
    expect(section.issueCount).toBeGreaterThanOrEqual(1);
    vi.unstubAllGlobals();
  });
});
