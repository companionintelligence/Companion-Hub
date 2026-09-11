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
import { CANONICAL_BIND_DROPIN } from '../lib/fleet-ollama-bind.js';
import type { HostFacts } from '../lib/fleet-hardware.js';

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
  it('is written into the unit file on Strix Halo', () => {
    // ROCm there runs NO_VMM: the driver advertises the whole ~60 GB GTT pool as free and then fails
    // to allocate 21 GB, so every real model 500s. Six nodes were dead this way until it was forced.
    const plan = planBackend('ollama', host({ gpus: [strixHalo] }), '/data');
    expect(plan.action).toBe('install');
    expect(plan.script).toContain('OLLAMA_LLM_LIBRARY=vulkan');
  });

  it('is NOT written on hardware that does not need it', () => {
    // core-1 reports its pool the other way round and serves fine under ROCm. Forcing Vulkan
    // everywhere would be a change nobody measured on the nodes that never had the problem.
    const plan = planBackend('ollama', host({ gpus: [nvidia] }), '/data');
    expect(plan.script).not.toContain('OLLAMA_LLM_LIBRARY=vulkan');
  });

  it('is the same environment on the adopt path, so a re-run never strips it', () => {
    expect(ollamaManagedEnvironment(host({ gpus: [strixHalo] }))).toEqual(['OLLAMA_LLM_LIBRARY=vulkan']);
    expect(ollamaManagedEnvironment(host({ gpus: [nvidia] }))).toEqual([]);
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
