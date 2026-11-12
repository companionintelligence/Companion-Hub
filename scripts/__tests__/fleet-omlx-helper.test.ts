/**
 * oMLX's Prefill Accelerator helper on NVIDIA nodes: `fleet backends --backends omlx-helper`.
 *
 * The helper serves nothing the Hub routes to, so the cases that matter are the ones that would put
 * a 2.3 GB container with three open ports on a machine that cannot use it, or replace a container
 * somebody else made: the gates, the opt-in, the adoption, and what the install script does to an
 * existing container. The script itself runs for real in bash, with `docker` and `curl` stubbed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Only so the probe script can be captured and run here in bash; nothing else in this file dials.
const ssh = vi.hoisted(() => ({ sshCapture: vi.fn() }));
vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: ssh.sshCapture,
}));

import { parseFleetArgs } from '../lib/cli-fleet.js';
import { DEFAULT_BACKENDS, INSTALLABLE_BACKENDS, planAllBackends, planBackend } from '../lib/fleet-backends.js';
import { type GpuInfo, type HostFacts, parseHostFacts, readHostFacts } from '../lib/fleet-hardware.js';
import {
  classifyOmlxHelperOutput,
  OMLX_HELPER_PINNED_VERSION,
  omlxHelperGate,
  omlxHelperInstallScript,
  resolveOmlxHelperVersion,
} from '../lib/fleet-omlx-helper.js';

const a6000: GpuInfo = {
  vendor: 'nvidia',
  name: 'NVIDIA RTX A6000',
  reportedVramMib: 49140,
  driverWorking: true,
  driverVersion: '580.95.05',
  computeCapability: '8.6',
};

const host = (over: Partial<HostFacts> = {}): HostFacts => ({
  os: 'linux',
  arch: 'x86_64',
  appleSilicon: false,
  cpuCount: 32,
  load1: 0.1,
  docker: { present: true, usable: true },
  gpus: [a6000],
  nvidiaContainerHook: true,
  enginesListening: [11434],
  notes: [],
  ...over,
});

describe('the pinned helper version', () => {
  it('defaults to the pin, accepts an exact release, and refuses latest', () => {
    expect(resolveOmlxHelperVersion()).toBe(OMLX_HELPER_PINNED_VERSION);
    expect(resolveOmlxHelperVersion('v0.1.4')).toBe('0.1.4');
    expect(() => resolveOmlxHelperVersion('latest')).toThrow(/exact release/);
    expect(() => resolveOmlxHelperVersion('0.1')).toThrow(/x\.y\.z/);
  });

  it('is parsed and validated before any node is dialled, and only for backends', () => {
    expect(parseFleetArgs(['backends', '--backends', 'omlx-helper', '--omlx-helper-version', '0.1.4']).omlxHelperVersion).toBe('0.1.4');
    expect(() => parseFleetArgs(['backends', '--omlx-helper-version', 'latest'])).toThrow(/exact release/);
    expect(() => parseFleetArgs(['status', '--omlx-helper-version', '0.1.4'])).toThrow(/only applies to `fleet backends/);
  });
});

describe('gates', () => {
  const why = (over: Partial<HostFacts>) => {
    const gate = omlxHelperGate(host(over));
    return gate.ok ? 'ok' : gate.why;
  };

  it('passes an Ampere card on driver 580 with Docker and the toolkit, and names the card', () => {
    expect(omlxHelperGate(host())).toEqual({ ok: true, gpu: 'NVIDIA RTX A6000, driver 580.95.05, compute 8.6' });
  });

  it('sends a Mac to oMLX’s own Cluster tab, and refuses Windows', () => {
    expect(why({ os: 'darwin', appleSilicon: true, arch: 'arm64', gpus: [] })).toMatch(/Cluster tab/);
    expect(why({ os: 'windows' })).toMatch(/Linux/);
  });

  it('needs a working NVIDIA driver', () => {
    expect(why({ gpus: [] })).toMatch(/requires an NVIDIA GPU/);
    expect(why({ gpus: [{ vendor: 'nvidia', name: 'RTX 3090', driverWorking: false, driverNote: 'nvidia-smi did not answer' }] })).toMatch(
      /driver is not answering/,
    );
  });

  it('refuses a driver older than 580 or one it could not read: the image is CUDA 13', () => {
    // Nothing in the container checks this at start; the first long prompt from the Mac would fail.
    expect(why({ gpus: [{ ...a6000, driverVersion: '575.64.03' }] })).toMatch(/575\.64\.03 is older than 580/);
    expect(why({ gpus: [{ ...a6000, driverVersion: undefined }] })).toMatch(/could not read the NVIDIA driver version/);
  });

  it('refuses a card older than Ampere, judged by the lowest compute capability', () => {
    expect(why({ gpus: [{ ...a6000, name: 'Tesla T4', computeCapability: '7.5' }] })).toMatch(/Tesla T4 is compute capability 7\.5/);
    // Blackwell's 12.0 sorts above 8.0 as a number, not as a string.
    expect(why({ gpus: [{ ...a6000, computeCapability: '12.0' }] })).toBe('ok');
  });

  it('needs Docker this account can use, and the toolkit that --gpus needs', () => {
    expect(why({ docker: { present: false, usable: false } })).toMatch(/Docker is not installed/);
    expect(why({ docker: { present: true, usable: false } })).toMatch(/cannot use it/);
    expect(why({ nvidiaContainerHook: false })).toMatch(/NVIDIA Container Toolkit/);
    // Unread is not absent: a facts object from before the probe asked must not block.
    expect(why({ nvidiaContainerHook: undefined })).toBe('ok');
  });
});

describe('planning', () => {
  it('is opt-in: a plain fleet backends never plans it, and naming it does', () => {
    expect(INSTALLABLE_BACKENDS).toContain('omlx-helper');
    expect(DEFAULT_BACKENDS).not.toContain('omlx-helper');
    expect(planAllBackends(host(), '/data').map((p) => p.backend)).not.toContain('omlx-helper');
    expect(planAllBackends(host(), '/data', ['omlx-helper']).map((p) => p.action)).toEqual(['install']);
  });

  it('installs the pinned image with upstream’s flags, a label, and no sudo', () => {
    const plan = planBackend('omlx-helper', host(), '/data');
    expect(plan.action).toBe('install');
    expect(plan.port).toBe(8850);
    expect(plan.needsSudo).toBeFalsy();
    expect(plan.why).toContain(`jundot/omlx-cuda-helper:${OMLX_HELPER_PINNED_VERSION}`);
    expect(plan.why).toContain('every interface');
    expect(plan.script).toContain(
      'docker run -d --name "$cihub_name" --label \'ci-hub.fleet-backend=omlx-helper\' --restart unless-stopped --gpus all --network host -v \'omlx-helper:/data\' "$cihub_image"',
    );
    expect(plan.script).toContain(`cihub_image='jundot/omlx-cuda-helper:${OMLX_HELPER_PINNED_VERSION}'`);
    expect(planBackend('omlx-helper', host(), '/data', { omlxHelperVersion: '0.1.4' }).script).toContain(
      "cihub_image='jundot/omlx-cuda-helper:0.1.4'",
    );
  });

  it('adopts a helper that already answers on :8850, and says when it is not the pin', () => {
    const adopted = planBackend(
      'omlx-helper',
      host({ enginesListening: [8850], engineOwners: { 8850: 'omlx-cuda-helper' }, omlxHelperVersion: OMLX_HELPER_PINNED_VERSION }),
      '/data',
    );
    expect(adopted.action).toBe('adopt');
    expect(adopted.why).not.toContain('is the pin');
    const older = planBackend(
      'omlx-helper',
      host({ enginesListening: [8850], engineOwners: { 8850: 'omlx-cuda-helper' }, omlxHelperVersion: '0.1.0' }),
      '/data',
    );
    expect(older.action).toBe('adopt');
    expect(older.why).toContain('omlx-cuda-helper 0.1.0 already answers on :8850');
    expect(older.why).toContain(`${OMLX_HELPER_PINNED_VERSION} is the pin`);
  });

  it('adopts even where the gates would refuse a fresh install: it is already running', () => {
    const plan = planBackend('omlx-helper', host({ gpus: [], enginesListening: [8850], engineOwners: { 8850: 'omlx-cuda-helper' } }), '/data');
    expect(plan.action).toBe('adopt');
  });

  it('skips when something else holds :8850', () => {
    const plan = planBackend('omlx-helper', host({ enginesListening: [8850] }), '/data');
    expect(plan.action).toBe('skip');
    expect(plan.why).toMatch(/does not answer as omlx-cuda-helper/);
  });
});

describe('the hardware probe', () => {
  const base = ['os=Linux', 'arch=x86_64', 'cpus=32', 'ram_mib=257000', 'nvidia_smi=NVIDIA RTX A6000, 49140'];

  it('reads the driver, the lowest compute capability, the toolkit hook, and the helper on :8850', () => {
    const facts = parseHostFacts(
      [
        ...base,
        'nvidia_info=580.95.05, 12.0;580.95.05, 8.6;',
        'nvidia_ctk_hook=nvidia-container-runtime-hook',
        'listening=11434',
        'listening=8850',
        'owner_8850=omlx-cuda-helper',
        'omlx_helper_version=0.1.3',
      ].join('\n'),
    );
    expect(facts.gpus[0]).toMatchObject({ vendor: 'nvidia', driverVersion: '580.95.05', computeCapability: '8.6' });
    expect(facts.nvidiaContainerHook).toBe(true);
    expect(facts.engineOwners).toEqual({ 8850: 'omlx-cuda-helper' });
    expect(facts.omlxHelperVersion).toBe('0.1.3');
  });

  it('keeps the driver version from a driver too old to know compute_cap', () => {
    // The first query fails with this sentence on such a driver; the fallback asks for the driver alone.
    const facts = parseHostFacts(
      [...base, 'nvidia_info=Field "compute_cap" is not a valid field to query.;470.256.02;', 'nvidia_ctk_hook=none'].join('\n'),
    );
    expect(facts.gpus[0]?.driverVersion).toBe('470.256.02');
    expect(facts.gpus[0]?.computeCapability).toBeUndefined();
    expect(facts.nvidiaContainerHook).toBe(false);
  });

  it('leaves every new field unset on a node without nvidia-smi', () => {
    const facts = parseHostFacts(['os=Linux', 'arch=x86_64', 'nvidia_smi='].join('\n'));
    expect(facts.gpus).toEqual([]);
    expect(facts.nvidiaContainerHook).toBeUndefined();
    expect(facts.omlxHelperVersion).toBeUndefined();
  });
});

describe('reading the install script’s output', () => {
  const identity = ['omlx-helper-version: 0.1.3', 'omlx-helper-name: core-1', 'omlx-helper-chip: 2x NVIDIA RTX A6000'];

  it('reports an install with the helper’s identity and how to pair it', () => {
    const result = classifyOmlxHelperOutput([...identity, 'omlx-helper-install-complete'].join('\n'), '');
    expect(result.outcome).toBe('installed');
    if (result.outcome !== 'installed') return;
    expect(result.identity).toEqual({ version: '0.1.3', name: 'core-1', chip: '2x NVIDIA RTX A6000' });
    expect(result.why).toContain('started omlx-cuda-helper 0.1.3 on 2x NVIDIA RTX A6000');
    expect(result.why).toContain('Cluster tab → Pair on core-1');
    expect(result.why).toContain('`docker logs omlx-helper`');
  });

  it('keeps refusals apart from failures, and names a missing toolkit', () => {
    expect(classifyOmlxHelperOutput('omlx-helper-refused: a container named omlx-helper exists (exited)', '').outcome).toBe('refused');
    const failed = classifyOmlxHelperOutput(
      'omlx-helper-failed: docker run failed: docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].',
      '',
    );
    expect(failed.outcome).toBe('failed');
    if (failed.outcome === 'failed') expect(failed.why).toMatch(/install the NVIDIA Container Toolkit and restart Docker/);
  });

  it('is incomplete without a marker, so the caller’s SSH diagnosis decides', () => {
    expect(classifyOmlxHelperOutput('', 'sudo: a password is required').outcome).toBe('incomplete');
  });
});

// ─── The script, run for real ────────────────────────────────────────────────────────────────────

/** The body `identity()` in omlx_cuda_helper/discovery.py serves, as Python's json.dumps writes it. */
const IDENTITY =
  '{"node_id": "6f1c2a90-1d2b-4b8e-9b55-0d6f8e7c1a42", "version": "0.1.3", "cluster_name": "omlx", "friendly_name": "core-1", ' +
  '"caps": {"chip": "2x NVIDIA RTX A6000", "ram_gb": 96.0, "backends": ["cuda"], "thunderbolt": false, "jaccl": false, "loopback_only": false, "control": "agent"}, ' +
  '"control_port": 8851}';

/** Docker's command line, kept as state files: enough of `info`, `inspect`, `pull`, `run`, `rm`, `stop` and `logs`. */
const FAKE_DOCKER = `#!/bin/sh
S="$HELPER_STATE"
echo "$*" >> "$S/calls"
case "$1" in
  info) [ -f "$S/docker-down" ] && exit 1; exit 0 ;;
  inspect)
    [ -f "$S/container" ] || { echo "Error: No such object: $4" >&2; exit 1; }
    case "$3" in
      *State.Status*) cat "$S/status" ;;
      *Labels*) if [ -f "$S/label" ]; then cat "$S/label"; else echo '<no value>'; fi ;;
      *RestartCount*) if [ -f "$S/restarts" ]; then cat "$S/restarts"; else echo 0; fi ;;
    esac
    exit 0 ;;
  pull) echo "$3"; exit 0 ;;
  run)
    if [ -f "$S/run-fails" ]; then echo 'docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]].' >&2; exit 125; fi
    : > "$S/container"; echo running > "$S/status"
    case "$*" in *"--label ci-hub.fleet-backend=omlx-helper"*) echo omlx-helper > "$S/label" ;; esac
    if [ -f "$S/crashes" ]; then echo 3 > "$S/restarts"; else : > "$S/up"; fi
    echo 4f2e9c; exit 0 ;;
  rm) rm -f "$S/container" "$S/status" "$S/label" "$S/restarts"; exit 0 ;;
  stop) echo exited > "$S/status"; exit 0 ;;
  logs) [ -f "$S/logs" ] && cat "$S/logs"; exit 0 ;;
esac
exit 0
`;

const FAKE_CURL = `#!/bin/sh
[ -f "$HELPER_STATE/up" ] && { cat "$HELPER_STATE/identity"; exit 0; }
exit 7
`;

/** The script's fresh-install path asks the real 127.0.0.1:8850 whether anything listens. */
const port8850Busy = spawnSync('bash', ['-c', '(echo > /dev/tcp/127.0.0.1/8850) >/dev/null 2>&1']).status === 0;

interface NodeState {
  container?: { status: string; label?: string };
  /** The helper answers on :8850 before anything runs (a running container, or an install outside Docker). */
  answering?: boolean;
  toolkit?: boolean;
  runFails?: boolean;
  crashes?: boolean;
  logs?: string;
}

function runOnNode(node: NodeState) {
  const state = mkdtempSync(join(tmpdir(), 'omlx-helper-state-'));
  const bin = mkdtempSync(join(tmpdir(), 'omlx-helper-bin-'));
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (node.toolkit !== false) writeFileSync(join(bin, 'nvidia-container-runtime-hook'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(state, 'identity'), IDENTITY);
  if (node.container) {
    writeFileSync(join(state, 'container'), '');
    writeFileSync(join(state, 'status'), `${node.container.status}\n`);
    if (node.container.label) writeFileSync(join(state, 'label'), `${node.container.label}\n`);
  }
  if (node.answering) writeFileSync(join(state, 'up'), '');
  if (node.runFails) writeFileSync(join(state, 'run-fails'), '');
  if (node.crashes) writeFileSync(join(state, 'crashes'), '');
  if (node.logs) writeFileSync(join(state, 'logs'), node.logs);
  const res = spawnSync('bash', ['-c', omlxHelperInstallScript(OMLX_HELPER_PINNED_VERSION)], {
    encoding: 'utf8',
    // Only the stubs and the base system: a docker or toolkit on the machine running the test must not answer for the node.
    env: { PATH: `${bin}:/usr/bin:/bin`, HELPER_STATE: state },
  });
  const calls = existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8').trim().split('\n') : [];
  return { code: res.status, out: res.stdout, err: res.stderr, calls, result: classifyOmlxHelperOutput(res.stdout, res.stderr) };
}

describe('the install script, run in bash', () => {
  it.skipIf(port8850Busy)('pulls the pinned image, starts it with the label, and reads the helper back', () => {
    const node = runOnNode({});
    expect(node.code).toBe(0);
    expect(node.calls).toContain(`pull -q jundot/omlx-cuda-helper:${OMLX_HELPER_PINNED_VERSION}`);
    expect(node.calls).toContain(
      `run -d --name omlx-helper --label ci-hub.fleet-backend=omlx-helper --restart unless-stopped --gpus all --network host -v omlx-helper:/data jundot/omlx-cuda-helper:${OMLX_HELPER_PINNED_VERSION}`,
    );
    expect(node.result).toMatchObject({ outcome: 'installed', identity: { version: '0.1.3', name: 'core-1', chip: '2x NVIDIA RTX A6000' } });
  });

  it('adopts a running helper container without pulling or restarting it', () => {
    const node = runOnNode({ container: { status: 'running', label: 'omlx-helper' }, answering: true });
    expect(node.result.outcome).toBe('adopted');
    expect(node.calls.filter((call) => /^(pull|run|rm|stop)\b/.test(call))).toEqual([]);
  });

  it('adopts a helper that answers outside Docker, and starts nothing beside it', () => {
    const node = runOnNode({ answering: true });
    expect(node.result.outcome).toBe('adopted');
    if (node.result.outcome === 'adopted') expect(node.result.why).toContain('outside Docker');
    expect(node.calls.filter((call) => /^(pull|run)\b/.test(call))).toEqual([]);
  });

  it('never touches a stopped omlx-helper container it did not create', () => {
    // Upstream's README has operators run this same container name by hand, with their own mounts.
    const node = runOnNode({ container: { status: 'exited' } });
    expect(node.result.outcome).toBe('refused');
    if (node.result.outcome === 'refused') expect(node.result.why).toContain('this CLI did not create');
    expect(node.calls.filter((call) => /^(rm|pull|run)\b/.test(call))).toEqual([]);
  });

  it.skipIf(port8850Busy)('replaces a stopped container it labelled, keeping the volume, so a re-run after a failure works', () => {
    const node = runOnNode({ container: { status: 'exited', label: 'omlx-helper' } });
    expect(node.calls).toContain('rm omlx-helper');
    expect(node.calls.some((call) => call.includes('volume'))).toBe(false);
    expect(node.result.outcome).toBe('installed');
    if (node.result.outcome === 'installed') expect(node.result.why).toContain('volume and its pairings are kept');
  });

  it.skipIf(port8850Busy)('refuses before pulling 2.3 GB when Docker cannot pass a GPU through', () => {
    const node = runOnNode({ toolkit: false });
    expect(node.result.outcome).toBe('refused');
    expect(node.calls.filter((call) => call.startsWith('pull'))).toEqual([]);
  });

  it.skipIf(port8850Busy)('names the toolkit when docker run cannot select a GPU driver', () => {
    const node = runOnNode({ runFails: true });
    expect(node.result.outcome).toBe('failed');
    if (node.result.outcome === 'failed') expect(node.result.why).toMatch(/install the NVIDIA Container Toolkit/);
  });

  it.skipIf(port8850Busy)('stops a helper that restarts in a loop, and quotes its log', () => {
    const node = runOnNode({ crashes: true, logs: 'ERROR no NVIDIA GPU found (nvidia-smi reports none)\n' });
    expect(node.calls).toContain('stop omlx-helper');
    expect(node.result.outcome).toBe('failed');
    if (node.result.outcome !== 'failed') return;
    expect(node.result.why).toMatch(/found no NVIDIA GPU inside its container/);
    expect(node.result.detail).toContain('no NVIDIA GPU found');
  });
});

// ─── The hardware probe, run for real ────────────────────────────────────────────────────────────

/** The probe script `readHostFacts` sends, captured rather than dialled. */
async function probeScript(): Promise<string> {
  let script = '';
  ssh.sshCapture.mockImplementation(async (_target: unknown, command: string) => {
    script = command;
    return { ok: true, out: 'os=Linux', err: '', code: 0, ms: 1 };
  });
  await readHostFacts({ host: 'core-1' });
  return script;
}

/** Runs the probe in bash with `nvidia-smi` and `curl` stubbed, and parses what it printed. */
async function probeNode(nvidiaSmi: string) {
  const bin = mkdtempSync(join(tmpdir(), 'omlx-helper-probe-'));
  writeFileSync(join(bin, 'nvidia-smi'), `#!/bin/sh\n${nvidiaSmi}`, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\ncase "$*" in *:8850/*) printf '%s' '${IDENTITY}' ;; *) exit 7 ;; esac\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'nvidia-container-runtime-hook'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const res = spawnSync('bash', ['-c', await probeScript()], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  return parseHostFacts(res.stdout);
}

describe('the hardware probe, run in bash', () => {
  it('reads the driver, the lowest compute capability, the toolkit, and the helper on :8850', async () => {
    const facts = await probeNode(
      [
        'case "$*" in',
        "  *name,memory.total*) echo 'NVIDIA RTX A6000, 49140'; echo 'NVIDIA GeForce RTX 5090, 32607' ;;",
        "  *driver_version,compute_cap*) echo '580.95.05, 8.6'; echo '580.95.05, 12.0' ;;",
        'esac',
      ].join('\n'),
    );
    expect(facts.gpus[0]).toMatchObject({ vendor: 'nvidia', name: 'NVIDIA RTX A6000', driverVersion: '580.95.05', computeCapability: '8.6' });
    expect(facts.nvidiaContainerHook).toBe(true);
    expect(facts.engineOwners?.[8850]).toBe('omlx-cuda-helper');
    expect(facts.omlxHelperVersion).toBe('0.1.3');
  });

  it('falls back to the driver alone where nvidia-smi refuses compute_cap', async () => {
    const facts = await probeNode(
      [
        'case "$*" in',
        "  *name,memory.total*) echo 'Tesla T4, 15360' ;;",
        `  *compute_cap*) echo 'Field "compute_cap" is not a valid field to query.'; exit 2 ;;`,
        "  *driver_version*) echo '470.256.02' ;;",
        'esac',
      ].join('\n'),
    );
    expect(facts.gpus[0]).toMatchObject({ name: 'Tesla T4', driverVersion: '470.256.02' });
    expect(facts.gpus[0]?.computeCapability).toBeUndefined();
    // The probe ran on whatever machine runs this test, so its OS is pinned for the gate.
    expect(omlxHelperGate({ ...facts, os: 'linux' })).toMatchObject({ ok: false, why: expect.stringContaining('470.256.02 is older than 580') });
  });
});
