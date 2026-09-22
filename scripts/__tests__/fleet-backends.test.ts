/**
 * Backend install planning.
 *
 * The planner decides what gets installed on fourteen machines, and every wrong answer is expensive
 * in a different way: installing over a live listener fights it for a port, claiming adoption credits
 * one backend with another's service, and a gate that fires wrongly leaves a GPU unused. Each case
 * below is a state observed on the real fleet.
 */

import { describe, expect, it } from 'vitest';
import { planBackend, planAllBackends, INSTALLABLE_BACKENDS, ollamaManagedEnvironment } from '../lib/fleet-backends.js';
import {
  CANONICAL_BIND_DROPIN,
  canonicalBindDropinContent,
  normalizeOllamaHost,
  parseServiceEnvironment,
  systemdNameCompare,
} from '../lib/fleet-ollama-bind.js';
import { ollamaRuntimeDropinContent, RUNTIME_DROPIN } from '../lib/fleet-ollama-runtime.js';
import { type HostFacts, isIntegratedAmdGpu } from '../lib/fleet-hardware.js';

const host = (over: Partial<HostFacts> = {}): HostFacts => ({
  os: 'linux',
  arch: 'x86_64',
  appleSilicon: false,
  cpuCount: 32,
  load1: 0.1,
  docker: { present: true, usable: true },
  gpus: [],
  enginesListening: [],
  notes: [],
  ...over,
});

const nvidia = { vendor: 'nvidia' as const, name: 'RTX 3080', reportedVramMib: 10240, driverWorking: true };
const strixHalo = { vendor: 'amd' as const, gfx: 'gfx1151', reportedVramMib: 2048, gttMib: 62061, driverWorking: true };
/** A discrete RDNA3 card: the same vendor, the same driver, its own memory. Neither key applies. */
const radeon7900 = { vendor: 'amd' as const, gfx: 'gfx1100', name: 'Radeon RX 7900 XTX', reportedVramMib: 24576, gttMib: 32768, driverWorking: true };

describe('adoption', () => {
  it('adopts a backend already answering on its own unambiguous port', () => {
    const plan = planBackend('ollama', host({ enginesListening: [11434] }), '/data');
    expect(plan.action).toBe('adopt');
    expect(plan.script).toBeUndefined();
  });

  it('refuses to attribute a shared 8000-space port to any one backend', () => {
    // vllm, mtplx and lucebox all default here. The first live run reported "adopt mtplx" on every
    // node running lucebox — crediting a backend installed nowhere on this fleet.
    for (const backend of ['mtplx', 'lucebox'] as const) {
      const plan = planBackend(backend, host({ enginesListening: [8000], gpus: [nvidia] }), '/data');
      expect(plan.action).toBe('skip');
      expect(plan.why).toMatch(/share it|cannot attribute/);
    }
  });
});

describe('gates', () => {
  it('does not offer vLLM without an NVIDIA GPU', () => {
    expect(planBackend('vllm', host({ gpus: [strixHalo] }), '/data').action).toBe('skip');
  });

  it('does not offer vLLM when the card is present but its driver is dead', () => {
    // Observed: lspci showed the card, nvidia-smi failed, and the node ran CPU-only for weeks.
    const dead = { vendor: 'nvidia' as const, name: 'RTX 3070', driverWorking: false, driverNote: 'nvidia-smi did not answer' };
    const plan = planBackend('vllm', host({ gpus: [dead] }), '/data');
    expect(plan.action).toBe('skip');
    expect(plan.why).toMatch(/driver is not answering/);
  });

  it('does not offer lucebox when docker is present but unusable', () => {
    const plan = planBackend('lucebox', host({ gpus: [nvidia], docker: { present: true, usable: false } }), '/data');
    expect(plan.action).toBe('skip');
    expect(plan.why).toMatch(/docker info` failed/);
  });

  it('never installs lemonade — it is operator-managed by design', () => {
    // Excluded from the desktop's DEFAULT_AUTOMATIC_RUNNERS too; the Hub only probes it.
    expect(planBackend('lemonade', host(), '/data').action).toBe('skip');
  });

  it('refuses the MLX runners off Apple Silicon', () => {
    for (const backend of ['dspark', 'mtplx'] as const) {
      expect(planBackend(backend, host(), '/data').action).toBe('skip');
    }
  });

  it('will not install ollama headlessly on macOS, where the daemon is a GUI app', () => {
    const plan = planBackend('ollama', host({ os: 'darwin', appleSilicon: true, arch: 'arm64' }), '/data');
    expect(plan.action).toBe('skip');
    expect(plan.why).toMatch(/GUI app/);
  });
});

describe('the gfx1151 Vulkan override', () => {
  it('is written into the unit file on Strix Halo, with the iGPU key beside it', () => {
    // ROCm there runs NO_VMM: the driver advertises the whole ~60 GB GTT pool as free and then fails
    // to allocate 21 GB, so every real model 500s. Six nodes were dead this way until it was forced.
    // And Vulkan alone is not enough: Ollama 0.34 drops an integrated GPU unless OLLAMA_IGPU_ENABLE=1,
    // so the same six nodes then served qwen3-coder:30b from the CPU (size_vram 0, 37.5 tok/s against
    // 75–79 with the key) with every health check green. Both keys, one file, or neither is safe.
    const plan = planBackend('ollama', host({ gpus: [strixHalo] }), '/data');
    expect(plan.action).toBe('install');
    expect(plan.script).toContain('Environment="OLLAMA_LLM_LIBRARY=vulkan"');
    expect(plan.script).toContain('Environment="OLLAMA_IGPU_ENABLE=1"');
  });

  it('is NOT written on hardware that does not need it', () => {
    // core-1 reports its pool the other way round and serves fine under ROCm. Forcing Vulkan
    // everywhere would be a change nobody measured on the nodes that never had the problem.
    const plan = planBackend('ollama', host({ gpus: [nvidia] }), '/data');
    expect(plan.script).not.toContain('OLLAMA_LLM_LIBRARY=vulkan');
    expect(plan.script).not.toContain('OLLAMA_IGPU_ENABLE');
  });

  it('writes neither key for a discrete AMD card — same vendor, its own memory, no iGPU to enable', () => {
    expect(isIntegratedAmdGpu(radeon7900)).toBe(false);
    expect(ollamaManagedEnvironment(host({ gpus: [radeon7900] }))).toEqual([]);
    const plan = planBackend('ollama', host({ gpus: [radeon7900] }), '/data');
    expect(plan.script).not.toContain('OLLAMA_LLM_LIBRARY');
    expect(plan.script).not.toContain('OLLAMA_IGPU_ENABLE');
  });

  it('is the same environment on the adopt path, so a re-run never strips either key', () => {
    expect(ollamaManagedEnvironment(host({ gpus: [strixHalo] }))).toEqual(['OLLAMA_LLM_LIBRARY=vulkan', 'OLLAMA_IGPU_ENABLE=1']);
    expect(ollamaManagedEnvironment(host({ gpus: [nvidia] }))).toEqual([]);
    expect(ollamaManagedEnvironment(host({ gpus: [] }))).toEqual([]);
  });

  it('cannot be dropped by a runtime run that omits --ollama-igpu: the key lives in the bind file', () => {
    // The failure mode measured 2026-09-21: the key was in the runtime file, rendered whole from
    // the flags on every run, and a run with `--ollama-parallel` alone rendered it away. The bind
    // file is rendered from the hardware, and the hardware does not change between runs.
    const bind = canonicalBindDropinContent(normalizeOllamaHost('0.0.0.0'), ollamaManagedEnvironment(host({ gpus: [strixHalo] })));
    const bindKeys = parseServiceEnvironment(bind).flatMap((d) => (d.kind === 'set' ? [d.key] : []));
    expect(bindKeys).toEqual(['OLLAMA_HOST', 'OLLAMA_LLM_LIBRARY', 'OLLAMA_IGPU_ENABLE']);
    const runtimeWithoutIgpu = ollamaRuntimeDropinContent({ parallel: 4, keepAlive: '24h' });
    expect(runtimeWithoutIgpu).not.toContain('OLLAMA_IGPU_ENABLE');
  });

  it('pins the precedence: the bind file sorts before the runtime file, so --ollama-igpu on|off is the override that wins', () => {
    // systemd applies drop-ins in byte order of filename, last assignment winning. `b` < `r`, so the
    // bind file's OLLAMA_IGPU_ENABLE=1 is the hardware default and the runtime file's explicit
    // `--ollama-igpu off` (=0) outranks it — the operator's word beats the installer's. If either
    // file is ever renamed, this is the test that says the override silently stopped working.
    expect(systemdNameCompare(CANONICAL_BIND_DROPIN, RUNTIME_DROPIN)).toBeLessThan(0);
    // And the override is a real value, not an absence: `off` writes 0, which is what outranks 1.
    expect(ollamaRuntimeDropinContent({ igpu: false })).toContain('Environment="OLLAMA_IGPU_ENABLE=0"');
  });
});

describe('the ollama bind policy', () => {
  it('binds all interfaces by default, behind the guard, and says so in the plan', () => {
    // Measured 2026-09-10: nodes bound the Tailscale IP, 0.0.0.0 and loopback in roughly equal
    // measure, and a loopback probe read "no Ollama" on healthy tailnet-bound nodes. One policy.
    const plan = planBackend('ollama', host(), '/data');
    expect(plan.why).toContain('all interfaces');
    expect(plan.why).toContain('guarded');
    expect(plan.script).toContain("cihub_bind_host='0.0.0.0'");
    // The guard is what makes 0.0.0.0 acceptable, and it goes up before the daemon restarts onto it.
    const guardUp = plan.script?.indexOf('systemctl restart ollama-tailnet-guard.service') ?? -1;
    const daemonUp = plan.script?.indexOf('\nsystemctl restart ollama\n') ?? -1;
    expect(guardUp).toBeGreaterThan(-1);
    expect(daemonUp).toBeGreaterThan(guardUp);
  });

  it('honours --bind all and --bind local as explicit alternatives', () => {
    expect(planBackend('ollama', host(), '/data', { ollamaBind: 'all' }).script).toContain("cihub_bind_host='0.0.0.0'");
    expect(planBackend('ollama', host(), '/data', { ollamaBind: 'local' }).script).toContain("cihub_bind_host='127.0.0.1'");
    expect(planAllBackends(host(), '/data', ['ollama'], { ollamaBind: 'all' })[0]?.why).toContain('0.0.0.0');
  });

  it('writes ONE canonical drop-in and no longer the old companionhub.conf', () => {
    const script = planBackend('ollama', host({ gpus: [strixHalo] }), '/data').script ?? '';
    expect(script).toContain(`cihub_bind_file='${CANONICAL_BIND_DROPIN}'`);
    expect(script).not.toContain('companionhub.conf');
    // The managed environment rides in the same file.
    expect(script).toContain('Environment="OLLAMA_LLM_LIBRARY=vulkan"');
    expect(script).toContain('Environment="OLLAMA_IGPU_ENABLE=1"');
    expect((script.match(/cat >"\$cihub_bind_dir\/\$cihub_bind_file"/g) ?? []).length).toBe(1);
  });

  it('checks who owns :11434 BEFORE running ollama.com’s installer', () => {
    // install.sh runs `systemctl enable ollama && systemctl restart ollama` itself. On beta-1, where
    // a user-scope ollama-local.service owns the port, that is the collision — so the guard must
    // come first, not after.
    const script = planBackend('ollama', host(), '/data').script ?? '';
    expect(script.indexOf('ollama-bind-refused:')).toBeGreaterThan(-1);
    expect(script.indexOf('ollama-bind-refused:')).toBeLessThan(script.indexOf('https://ollama.com/install.sh'));
  });

  it('decides ownership of :11434 by the listener, not by a user unit’s name', () => {
    // core-2 (2026-09-21): `ollama-tunnel.service` under ci's systemd --user is an ssh forward,
    // and the SYSTEM ollama.service serves the port. A guard that asked the user managers first
    // skipped the node. The guard classifies the socket by its cgroup (ss -e), and a name-matched
    // user unit is overruled only when the SYSTEM unit was found serving the port.
    const script = planBackend('ollama', host(), '/data').script ?? '';
    expect(script).toContain('ss -ltnpe');
    expect(script).toContain('cgroup:');
    const listeners = script.indexOf('for cihub_row in $(ss -ltnpe');
    const userManagers = script.indexOf('loginctl list-users');
    expect(listeners).toBeGreaterThan(-1);
    expect(userManagers).toBeGreaterThan(listeners);
    expect(script).toContain(
      "ollama-bind-note: $uu is active under $u's systemd --user, but the system ollama.service ($cihub_sys_pid) is what serves :11434",
    );
    // The genuine case keeps its message — and it is also the answer when nothing listens: a free
    // port is what a user-scope daemon looks like mid-restart, so the guard never notes that away.
    expect(script).toContain(
      "ollama-bind-refused: $uu is running under $u's systemd --user; the system ollama.service path would start a second daemon and collide on :11434",
    );
    expect(script).not.toContain('nothing listens');
  });

  it('fails a tailnet bind on a node with no tailnet address BEFORE downloading anything', () => {
    const script = planBackend('ollama', host(), '/data', { ollamaBind: 'tailnet' }).script ?? '';
    const check = script.indexOf('--bind tailnet needs a tailnet address');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(script.indexOf('https://ollama.com/install.sh'));
    // Not asked for when the mode does not need it.
    expect(planBackend('ollama', host(), '/data', { ollamaBind: 'all' }).script).not.toContain('needs a tailnet address');
  });

  it('no longer runs `systemctl enable --now` unconditionally, and re-reads the bind after restart', () => {
    const script = planBackend('ollama', host(), '/data').script ?? '';
    expect(script).not.toContain('systemctl enable --now ollama');
    expect(script.indexOf('systemctl restart ollama')).toBeLessThan(script.indexOf('systemctl show ollama -p Environment'));
    expect(script).toContain('ollama-bind-mismatch:');
  });
});

describe('install scripts', () => {
  it('downloads the ollama installer to a file rather than piping it to a shell', () => {
    // A POSIX pipeline reports only the last command's status, so `curl | sh` executes a truncated
    // download and then reports success.
    const script = planBackend('ollama', host(), '/data').script ?? '';
    expect(script).toContain('-o "$installer"');
    expect(script).not.toMatch(/curl[^\n]*\|\s*sh/);
  });

  it('marks the ollama install as needing root, so a dry run can say so', () => {
    expect(planBackend('ollama', host(), '/data').needsSudo).toBe(true);
  });

  it('maps the lucebox container port correctly onto the host port', () => {
    // Internal 8080 → host port. Reversing it yields a container that starts and never answers.
    const script = planBackend('lucebox', host({ gpus: [nvidia] }), '/data').script ?? '';
    expect(script).toContain('-p 8000:8080');
  });

  it('picks the ROCm image for AMD and the CUDA image for NVIDIA', () => {
    expect(planBackend('lucebox', host({ gpus: [strixHalo] }), '/data').script).toContain('lucebox-hub:rocm');
    expect(planBackend('lucebox', host({ gpus: [nvidia] }), '/data').script).toContain('lucebox-hub:cuda12');
  });

  it('requires Python 3.10+ for vLLM, matching the desktop installer', () => {
    const script = planBackend('vllm', host({ gpus: [nvidia] }), '/data').script ?? '';
    expect(script).toContain('-ge 10');
    expect(script).toContain('pip install --upgrade vllm');
  });
});

describe('planAllBackends', () => {
  it('covers every installable backend by default, and every plan explains itself', () => {
    const plans = planAllBackends(host({ gpus: [nvidia] }), '/data');
    expect(plans).toHaveLength(INSTALLABLE_BACKENDS.length);
    for (const plan of plans) expect(plan.why.length).toBeGreaterThan(10);
  });

  it('honours an explicit subset', () => {
    expect(planAllBackends(host(), '/data', ['ollama']).map((p) => p.backend)).toEqual(['ollama']);
  });
});
