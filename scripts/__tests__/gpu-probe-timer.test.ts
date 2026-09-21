/**
 * The fleet step that installs `scripts/host-probes/cihub-gpu-processes.*` on a node, and the probe
 * it ships. The probe runs for real under `bash` with a fake vendor tool on PATH that replays the
 * live captures the Hub's parsers are tested with (`gpu-process-sampler.service.test.ts`), and what
 * it writes must be the document the Hub's reader expects, row for row.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_GPU_PROBE_SCRIPT, BUNDLED_GPU_PROBE_SERVICE, BUNDLED_GPU_PROBE_TIMER } from '../lib/bundled-hub-assets.generated.js';
import { installNode } from '../lib/fleet-install.js';
import {
  classifyGpuProbeOutput,
  describeGpuProbeOutcome,
  GPU_PROBE_INTERVAL_SECONDS,
  GPU_PROBE_SCRIPT_NAME,
  GPU_PROBE_SERVICE_UNIT,
  GPU_PROBE_TIMER_UNIT,
  installGpuProbeTimerScript,
} from '../lib/gpu-probe-timer.js';

// Captured live from beta-red (NVIDIA RTX 3080), 2026-09-15.
const NVIDIA_SMI_COMPUTE_APPS_OUTPUT = `6975, VLLM::EngineCore, 6104
286138, /usr/bin/baobab, 22
`;

// Captured live from beta-max (AMD Strix Halo, gfx1151), 2026-09-15, ROCm-SMI 4.0.0 / ROCM-SMI-LIB 7.8.0.
const ROCM_SMI_SHOWPIDS_OUTPUT = `

============================ ROCm System Management Interface ============================
===================================== KFD Processes ======================================
KFD process information:
PID 	PROCESS NAME   	GPU(s)	VRAM USED  	SDMA USED	CU OCCUPANCY
9399	VLLM::EngineCor	1     	329576448  	0        	UNKNOWN
6566	vllm           	0     	0          	0        	UNKNOWN
6534	dflash_server  	1     	18652127232	0        	UNKNOWN
==========================================================================================
================================== End of ROCm SMI Log ===================================
`;

/** Everything the probe calls, so PATH can be exactly the fake tool plus these and nothing else. `cat` is for the fake tool itself. */
const NEEDED_TOOLS = ['bash', 'awk', 'date', 'mkdir', 'mktemp', 'chmod', 'mv', 'printf', 'cat'];

const shellAvailable = NEEDED_TOOLS.every((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0);

type HostFile = {
  schemaVersion: number;
  sampledAt: string;
  source: string;
  vendor: string;
  processes: { pid: number; processName: string; vramMb: number }[];
};

describe.runIf(shellAvailable)('the bundled probe, run for real', () => {
  let root: string;
  let bin: string;
  let stateDir: string;

  const outputPath = () => path.join(stateDir, 'hardware', 'gpu_processes.json');
  const readOutput = (): HostFile => JSON.parse(readFileSync(outputPath(), 'utf8'));

  /** Put a fake vendor tool on PATH that prints `stdout` and exits `status`. */
  const fakeTool = (name: string, stdout: string, status = 0) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\ncat <<'CIHUB_FAKE_TOOL'\n${stdout}CIHUB_FAKE_TOOL\nexit ${status}\n`);
    chmodSync(file, 0o755);
  };

  const runProbe = () =>
    spawnSync(path.join(bin, 'bash'), [path.join(root, GPU_PROBE_SCRIPT_NAME)], {
      encoding: 'utf8',
      // A minimal PATH: only the fake tool and the coreutils the script uses. The developer machine
      // may have a real nvidia-smi, and the AMD case must not find it.
      env: { PATH: bin, HOME: path.join(root, 'home'), CI_HUB_STATE_PATH: stateDir },
    });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cihub-gpu-probe-'));
    bin = path.join(root, 'bin');
    stateDir = path.join(root, 'state');
    mkdirSync(bin);
    mkdirSync(path.join(root, 'home'));
    for (const tool of NEEDED_TOOLS) {
      const resolved = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(resolved, path.join(bin, tool));
    }
    writeFileSync(path.join(root, GPU_PROBE_SCRIPT_NAME), BUNDLED_GPU_PROBE_SCRIPT);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the beta-red NVIDIA capture as the document the Hub reads', () => {
    fakeTool('nvidia-smi', NVIDIA_SMI_COMPUTE_APPS_OUTPUT);

    const run = runProbe();
    expect(run.status, run.stderr).toBe(0);

    const parsed = readOutput();
    expect(parsed).toMatchObject({ schemaVersion: 1, vendor: 'nvidia', source: 'nvidia-smi' });
    expect(Math.abs(Date.now() - Date.parse(parsed.sampledAt))).toBeLessThan(60_000);
    // Row for row what parseNvidiaSmiComputeApps yields for the same capture.
    expect(parsed.processes).toEqual([
      { pid: 6975, processName: 'VLLM::EngineCore', vramMb: 6104 },
      { pid: 286138, processName: '/usr/bin/baobab', vramMb: 22 },
    ]);
  });

  it('writes the beta-max AMD table with bytes rounded to MiB as the Hub rounds them, dropping the zero-VRAM row', () => {
    fakeTool('rocm-smi', ROCM_SMI_SHOWPIDS_OUTPUT);

    const run = runProbe();
    expect(run.status, run.stderr).toBe(0);
    const parsed = readOutput();
    expect(parsed).toMatchObject({ vendor: 'amd', source: 'rocm-smi' });
    // Math.round(329576448 / 2**20) and Math.round(18652127232 / 2**20), as parseRocmSmiShowPids does.
    expect(parsed.processes).toEqual([
      { pid: 9399, processName: 'VLLM::EngineCor', vramMb: 314 },
      { pid: 6534, processName: 'dflash_server', vramMb: 17788 },
    ]);
  });

  it('writes an empty process list — a measurement — when the tool answers with no rows', () => {
    fakeTool('nvidia-smi', '');
    expect(runProbe().status).toBe(0);
    expect(readOutput().processes).toEqual([]);
  });

  it('keeps the JSON valid when a process name carries a quote or a backslash', () => {
    fakeTool('nvidia-smi', '999, /opt/we"ird\\name, 5\n1000, [N/A], [N/A]\n');
    expect(runProbe().status).toBe(0);
    expect(readOutput().processes).toEqual([{ pid: 999, processName: '/opt/we"ird\\name', vramMb: 5 }]);
  });

  it('leaves the previous file alone and exits non-zero when an installed tool fails', () => {
    // An empty list is "nothing holds VRAM" and may only be written when the tool said so. A tool
    // that failed must not produce one; the stale file ages out on the Hub's side instead.
    fakeTool('nvidia-smi', NVIDIA_SMI_COMPUTE_APPS_OUTPUT);
    expect(runProbe().status).toBe(0);
    const before = readFileSync(outputPath(), 'utf8');

    fakeTool('nvidia-smi', 'NVIDIA-SMI has failed\n', 6);
    const run = runProbe();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('nvidia-smi is installed but failed');
    expect(readFileSync(outputPath(), 'utf8')).toBe(before);
  });

  it('writes nothing, exiting 0, when neither tool is on PATH', () => {
    expect(runProbe().status).toBe(0);
    expect(existsSync(outputPath())).toBe(false);
  });

  it('prefers nvidia-smi when both tools exist', () => {
    fakeTool('nvidia-smi', NVIDIA_SMI_COMPUTE_APPS_OUTPUT);
    fakeTool('rocm-smi', ROCM_SMI_SHOWPIDS_OUTPUT);
    expect(runProbe().status).toBe(0);
    expect(readOutput().vendor).toBe('nvidia');
  });
});

describe('the bundled units', () => {
  it('run the script from where the install step puts it', () => {
    expect(BUNDLED_GPU_PROBE_SERVICE).toContain(`ExecStart=%h/.local/bin/${GPU_PROBE_SCRIPT_NAME}`);
  });

  it('fire well inside the reader window, with an accuracy tight enough to keep that cadence', () => {
    // The Hub ignores a file older than HOST_GPU_PROCESSES_FILE_MAX_AGE_MS (60 s); one missed tick
    // must still read as fresh. systemd's default AccuracySec of 1min would coalesce this to ~60 s.
    expect(GPU_PROBE_INTERVAL_SECONDS).toBeLessThanOrEqual(30);
    expect(BUNDLED_GPU_PROBE_TIMER).toMatch(/AccuracySec=[1-9]s/);
    expect(BUNDLED_GPU_PROBE_TIMER).toContain('WantedBy=timers.target');
  });
});

describe('installGpuProbeTimerScript', () => {
  const script = installGpuProbeTimerScript();

  it('refuses a node with neither tool instead of installing a timer that fails forever', () => {
    expect(script).toContain('gpu-probe-no-tool');
    expect(script.indexOf('gpu-probe-no-tool')).toBeLessThan(script.indexOf('mkdir -p'));
  });

  it('installs the checked-in files verbatim, under the unit names the fleet already has', () => {
    expect(script).toContain(`"$bin_dir/${GPU_PROBE_SCRIPT_NAME}"`);
    expect(script).toContain(`"$unit_dir/${GPU_PROBE_SERVICE_UNIT}"`);
    expect(script).toContain(`"$unit_dir/${GPU_PROBE_TIMER_UNIT}"`);
    expect(GPU_PROBE_TIMER_UNIT).toBe('cihub-gpu-processes.timer');
    expect(script).toContain(BUNDLED_GPU_PROBE_SCRIPT.trimEnd());
    expect(script).toContain(BUNDLED_GPU_PROBE_SERVICE.trimEnd());
    expect(script).toContain(BUNDLED_GPU_PROBE_TIMER.trimEnd());
    expect(script).toContain('${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user');
  });

  it('enables lingering BEFORE touching the user manager, since core-3 had no manager until then', () => {
    expect(script.indexOf('loginctl enable-linger')).toBeLessThan(script.indexOf('systemctl --user show-environment'));
    expect(script.indexOf('systemctl --user show-environment')).toBeLessThan(script.indexOf(`systemctl --user enable --now ${GPU_PROBE_TIMER_UNIT}`));
  });

  it('takes one sample before enabling the timer, so a tool that cannot answer is reported on the node line', () => {
    expect(script.indexOf('gpu-probe-sample-failed')).toBeLessThan(script.indexOf(`systemctl --user enable --now ${GPU_PROBE_TIMER_UNIT}`));
  });

  it('bails out loudly when there is still no user manager instead of pretending', () => {
    expect(script).toContain('gpu-probe-no-user-session');
  });

  it('nests its heredocs under a tag that cannot collide with the fleet step wrapper or the files', () => {
    // fleet-install wraps every step in `bash <<'CIHUB_STEP_EOF'`; the probe has heredocs of its own.
    expect(script).not.toContain('CIHUB_STEP_EOF');
    expect(BUNDLED_GPU_PROBE_SCRIPT).not.toContain('CIHUB_GPU_PROBE_FILE');
  });
});

describe('classifyGpuProbeOutput', () => {
  it('reports a clean install', () => {
    expect(classifyGpuProbeOutput('gpu-probe-installed\n', true)).toBe('installed');
  });

  it('reports a node with no tool as skipped, not failed', () => {
    expect(classifyGpuProbeOutput('gpu-probe-no-tool\n', true)).toBe('no-tool');
  });

  it('ranks a failed first sample above the lingering warning', () => {
    // The timer is in place either way; that the tool did not answer as this account is what the
    // operator has to act on.
    expect(classifyGpuProbeOutput('gpu-probe-sample-failed\ngpu-probe-no-linger\ngpu-probe-installed\n', true)).toBe('sample-failed');
    expect(classifyGpuProbeOutput('gpu-probe-no-linger\ngpu-probe-installed\n', true)).toBe('no-linger');
  });

  it('reports a node with no user manager', () => {
    expect(classifyGpuProbeOutput('gpu-probe-no-linger\ngpu-probe-no-user-session\n', true)).toBe('no-user-session');
  });

  it('treats a missing success marker as failure even on exit 0', () => {
    expect(classifyGpuProbeOutput('', true)).toBe('failed');
    expect(classifyGpuProbeOutput('gpu-probe-installed', false)).toBe('failed');
  });

  it('describes every outcome in words an operator can act on', () => {
    for (const outcome of ['installed', 'no-linger', 'sample-failed', 'no-user-session', 'no-tool', 'failed'] as const) {
      expect(describeGpuProbeOutcome(outcome).length).toBeGreaterThan(10);
    }
  });
});

// ─── In the install sequence ─────────────────────────────────────────────────

const installMocks = vi.hoisted(() => ({
  readHostFacts: vi.fn(),
  preflightNode: vi.fn(),
  sshCapture: vi.fn(),
}));

vi.mock('../lib/fleet-hardware.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-hardware.js')>()),
  readHostFacts: installMocks.readHostFacts,
}));

vi.mock('../lib/fleet-preflight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-preflight.js')>()),
  preflightNode: installMocks.preflightNode,
}));

vi.mock('../lib/fleet-ssh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/fleet-ssh.js')>()),
  sshCapture: installMocks.sshCapture,
}));

describe('installNode runs the gpu probe step', () => {
  const ssh = (out: string) => ({ ok: true, out, err: '', code: 0, ms: 1 });
  const facts = {
    os: 'linux',
    arch: 'x86_64',
    appleSilicon: false,
    cpuCount: 16,
    load1: 0.2,
    docker: { present: true, usable: true },
    gpus: [],
    enginesListening: [],
    notes: [],
  };

  /** Every other step answers with its marker; the probe step answers with `probeOutput`. */
  function installSsh(probeOutput: string) {
    installMocks.readHostFacts.mockReset().mockResolvedValue({ facts });
    installMocks.preflightNode.mockReset().mockResolvedValue({ node: 'hub-a', findings: [], verdict: 'ok', ms: 1 });
    installMocks.sshCapture.mockReset().mockImplementation(async (_target: unknown, cmd: string) => {
      if (cmd.includes(GPU_PROBE_SCRIPT_NAME)) return ssh(probeOutput);
      if (cmd.includes('command -v cihub')) return ssh('path=/usr/local/bin/cihub\ncihub 0.2.70');
      if (cmd.includes('cihub up --detached')) return ssh('hub-up-complete');
      if (cmd.includes('systemd/user')) return ssh('status-timer-installed');
      return ssh('');
    });
  }

  const opts = { postgresPassword: 'a-long-enough-password', pairingCode: 'ABC123' };

  it('runs after the status timer, and a node with neither tool is skipped rather than failed', async () => {
    installSsh('gpu-probe-no-tool\n');
    const report = await installNode({ name: 'hub-a', ip: '100.64.0.1' }, opts, 'root');
    const names = report.steps.map((s) => s.name);
    expect(names.indexOf('gpu probe timer')).toBeGreaterThan(names.indexOf('status timer'));
    const step = report.steps.find((s) => s.name === 'gpu probe timer');
    expect(step?.ok).toBe(true);
    expect(step?.skipped).toBe(true);
    expect(step?.detail).toMatch(/neither nvidia-smi nor rocm-smi/);
  });

  it('reports a clean install and sends the whole install script down the SSH session', async () => {
    installSsh('gpu-probe-installed\n');
    const report = await installNode({ name: 'hub-a', ip: '100.64.0.1' }, opts, 'root');
    const step = report.steps.find((s) => s.name === 'gpu probe timer');
    expect(step?.ok).toBe(true);
    expect(step?.skipped).toBeFalsy();
    expect(step?.detail).toMatch(new RegExp(`every ${GPU_PROBE_INTERVAL_SECONDS} seconds`));
    const sent = installMocks.sshCapture.mock.calls.find(([, cmd]) => (cmd as string).includes(GPU_PROBE_SCRIPT_NAME))?.[1] as string;
    expect(sent).toContain(installGpuProbeTimerScript());
  });

  it('marks the step failed, with the node output, when no marker comes back', async () => {
    installSsh('bash: line 12: systemctl: command not found\n');
    const report = await installNode({ name: 'hub-a', ip: '100.64.0.1' }, opts, 'root');
    const step = report.steps.find((s) => s.name === 'gpu probe timer');
    expect(step?.ok).toBe(false);
    expect(step?.detail).toMatch(/could not be installed: .*systemctl: command not found/);
  });
});
