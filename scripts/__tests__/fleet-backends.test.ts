/**
 * Backend install planning.
 *
 * The planner decides what gets installed on fourteen machines, and every wrong answer is expensive
 * in a different way: installing over a live listener fights it for a port, claiming adoption credits
 * one backend with another's service, and a gate that fires wrongly leaves a GPU unused. Each case
 * below is a state observed on the real fleet.
 */

import { describe, expect, it } from 'vitest';
import { hubProbePortsFor, planBackend, planAllBackends, INSTALLABLE_BACKENDS, ollamaManagedEnvironment } from '../lib/fleet-backends.js';
import { LLAMACPP_FLEET_PORT, LLAMACPP_UNIT } from '../lib/fleet-llamacpp.js';
import {
  CANONICAL_BIND_DROPIN,
  canonicalBindDropinContent,
  normalizeOllamaHost,
  parseServiceEnvironment,
  systemdNameCompare,
} from '../lib/fleet-ollama-bind.js';
import { ollamaRuntimeDropinContent, RUNTIME_DROPIN } from '../lib/fleet-ollama-runtime.js';
import { HUB_PROBE_PORTS } from '../lib/fleet-probe-firewall.js';
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

describe('llamacpp', () => {
  const named = { model: 'qwen3-coder:30b', modelWhy: '--llamacpp-model' };

  it('is never installed by a run that did not name it — it holds a model in memory beside Ollama', () => {
    const plan = planBackend('llamacpp', host({ gpus: [strixHalo] }), '/data');
    expect(plan.action).toBe('skip');
    expect(plan.why).toContain('--backends llamacpp');
    expect(planAllBackends(host({ gpus: [strixHalo] }), '/data').find((p) => p.backend === 'llamacpp')?.action).toBe('skip');
    // What is there is still reported, and adopted only on the server's own word: `owned_by:
    // llamacpp` on /v1/models. A plain `fleet backends` on a node with a stray listener on :8081
    // once read "adopted" and went on to rewrite the node's env file and recreate its Hub.
    const listening = { enginesListening: [LLAMACPP_FLEET_PORT] };
    const hand = planBackend('llamacpp', host({ ...listening, engineOwners: { [LLAMACPP_FLEET_PORT]: 'llamacpp' } }), '/data');
    expect(hand.action).toBe('adopt');
    expect(hand.why).toBe('already answering on :8081 (owned_by llamacpp) — adopted, nothing installed');
    const own = planBackend(
      'llamacpp',
      host({ ...listening, engineOwners: { [LLAMACPP_FLEET_PORT]: 'llamacpp' }, managedUnits: { [LLAMACPP_UNIT]: 'active' } }),
      '/data',
    );
    expect(own.action).toBe('adopt');
    expect(own.why).toContain(`${LLAMACPP_UNIT} is active and answers on :8081 (owned_by llamacpp) — left as it is`);
    // A listener that names nothing is reported as exactly that, whatever the unit says.
    const unnamed = planBackend('llamacpp', host(listening), '/data');
    expect(unnamed.action).toBe('skip');
    expect(unnamed.why).toBe('something answers on :8081 but does not name itself llamacpp on /v1/models — not adopted');
    const loading = planBackend('llamacpp', host({ ...listening, managedUnits: { [LLAMACPP_UNIT]: 'active' } }), '/data');
    expect(loading.action).toBe('skip');
    expect(loading.why).toContain('not adopted (cihub-llamacpp.service is active; a llama-server still loading names nothing yet)');
    // The unit is starting and the port is not up yet: not adopted either.
    const starting = planBackend('llamacpp', host({ managedUnits: { [LLAMACPP_UNIT]: 'activating' } }), '/data');
    expect(starting.action).toBe('skip');
    expect(starting.why).toContain('is activating but nothing answers on :8081 yet — not adopted');
    // Another engine on the port is refused on a named run and an unnamed one alike.
    expect(planBackend('llamacpp', host({ ...listening, engineOwners: { [LLAMACPP_FLEET_PORT]: 'vllm' } }), '/data').why).toContain(
      'naming itself "vllm"',
    );
  });

  it('renders the unit and the measured flags for the image the GPU decides, published on :8081 for loopback, the tailnet and docker0 — never 0.0.0.0', () => {
    const plan = planBackend('llamacpp', host({ gpus: [strixHalo] }), '/data', { llamacpp: named });
    expect(plan.action).toBe('install');
    expect(plan.needsSudo).toBe(true);
    expect(plan.port).toBe(8081);
    expect(plan.why).toContain('ROCm image');
    expect(plan.why).toContain("serving Ollama's qwen3-coder:30b (--llamacpp-model) as 4 × 32768 (-np 4 -c 131072)");
    expect(plan.script).toContain('server-rocm-b11065');
    expect(plan.script).toContain('--device /dev/kfd --device /dev/dri');
    // The bind addresses are resolved on the node when the unit is rendered: loopback always, then
    // `tailscale ip -4` and the docker0 gateway (what host.docker.internal is inside ci-hub). A bare
    // `-p 8081:8080` would be 0.0.0.0, DNATed past ufw and the port guard, and open to the LAN.
    expect(plan.script).toContain('-p 127.0.0.1:8081:8080');
    expect(plan.script).toContain('tailscale ip -4');
    expect(plan.script).toContain('ip -4 addr show docker0');
    expect(plan.script).toContain('docker network inspect bridge');
    expect(plan.script).toMatch(/ExecStart=\$cihub_lc_docker run --rm --name cihub-llamacpp \$cihub_lc_publish\$cihub_lc_gpu /);
    expect(plan.script).not.toContain('-p 8081:8080');
    expect(plan.script).not.toContain('0.0.0.0:8081');
    expect(plan.script).toContain('manifests/registry.ollama.ai/library/qwen3-coder/30b');
    expect(plan.llamacpp).toEqual({ flavour: 'server-rocm', model: 'qwen3-coder:30b', parallel: 4, contextLength: 32768 });

    expect(planBackend('llamacpp', host({ gpus: [nvidia] }), '/data', { llamacpp: named }).script).toContain('server-cuda-b11065');
    expect(planBackend('llamacpp', host({ gpus: [nvidia] }), '/data', { llamacpp: named }).script).toContain('--gpus all');
    expect(planBackend('llamacpp', host(), '/data', { llamacpp: named }).script).toContain(':server-b11065');
  });

  it('takes -np and -c from the same --ollama-parallel / --ollama-context values, four slots of 32k by default', () => {
    const plan = planBackend('llamacpp', host({ gpus: [strixHalo] }), '/data', { llamacpp: { ...named, parallel: 2, contextLength: 16384 } });
    expect(plan.why).toContain('as 2 × 16384 (-np 2 -c 32768)');
    expect(plan.script).toContain('-np 2 -ub 2048 -b 2048 --cache-reuse 256 --jinja --metrics -c 32768');
  });

  it('gates like lucebox: Linux with a usable Docker', () => {
    expect(planBackend('llamacpp', host({ os: 'darwin', appleSilicon: true, arch: 'arm64' }), '/data', { llamacpp: named }).why).toContain(
      'LLAMACPP_URL',
    );
    const plan = planBackend('llamacpp', host({ docker: { present: true, usable: false } }), '/data', { llamacpp: named });
    expect(plan.action).toBe('skip');
    expect(plan.why).toMatch(/docker info` failed/);
  });

  it('skips with the reason when no model could be had, and refuses a tag that could escape the unit', () => {
    const noModel = planBackend('llamacpp', host({ gpus: [strixHalo] }), '/data', {
      llamacpp: { modelError: "no --llamacpp-model, and this node's Hub pins nothing" },
    });
    expect(noModel.action).toBe('skip');
    expect(noModel.why).toBe("no --llamacpp-model, and this node's Hub pins nothing");
    expect(planBackend('llamacpp', host({ gpus: [strixHalo] }), '/data', { llamacpp: { model: "x'; rm -rf /" } }).action).toBe('skip');
  });

  it('reads the listener three ways: its own unit converges, a llama-server adopts, another engine refuses', () => {
    const listening = { enginesListening: [LLAMACPP_FLEET_PORT] };
    // This CLI's unit: converge. The apply shell restarts only if the unit's bytes change.
    const own = planBackend(
      'llamacpp',
      host({ ...listening, gpus: [strixHalo], engineOwners: { 8081: 'llamacpp' }, managedUnits: { [LLAMACPP_UNIT]: 'active' } }),
      '/data',
      { llamacpp: named },
    );
    expect(own.action).toBe('install');
    expect(own.why).toContain(`converging ${LLAMACPP_UNIT} (restart only if its unit changes)`);
    // A hand-started llama-server: adopted, like an Ollama on :11434.
    const hand = planBackend('llamacpp', host({ ...listening, gpus: [strixHalo], engineOwners: { 8081: 'llamacpp' } }), '/data', { llamacpp: named });
    expect(hand.action).toBe('adopt');
    expect(hand.script).toBeUndefined();
    // Something that names itself: refused, whatever unit state says.
    const foreign = planBackend('llamacpp', host({ ...listening, gpus: [strixHalo], engineOwners: { 8081: 'dflash' } }), '/data', {
      llamacpp: named,
    });
    expect(foreign.action).toBe('skip');
    expect(foreign.why).toContain('naming itself "dflash"');
    // A listener that names nothing (a llama-server still loading answers 503 on /v1/models): adopted
    // on port evidence, the way the unambiguous ports are, rather than fought for.
    const loading = planBackend('llamacpp', host({ ...listening, gpus: [strixHalo] }), '/data', { llamacpp: named });
    expect(loading.action).toBe('adopt');
    expect(loading.why).toContain(`not run by ${LLAMACPP_UNIT}`);
  });

  it('opens :8081 on the firewall only where the Hub will probe it: named in the run, or its unit already running', () => {
    // The Hub probes LLAMACPP_URL only when it is set, and this CLI sets it on exactly these nodes;
    // fleet-wide the rule would be one nothing ever matches, planned as "would add 1 rule" everywhere.
    expect(HUB_PROBE_PORTS).not.toContain(LLAMACPP_FLEET_PORT);
    expect(hubProbePortsFor(host(), false)).toEqual([...HUB_PROBE_PORTS]);
    expect(hubProbePortsFor(host(), true)).toEqual([8000, 8080, 8081, 13305, 8216]);
    expect(hubProbePortsFor(host({ managedUnits: { [LLAMACPP_UNIT]: 'active' } }), false)).toEqual([8000, 8080, 8081, 13305, 8216]);
    expect(hubProbePortsFor(host({ managedUnits: { [LLAMACPP_UNIT]: 'activating' } }), false)).toContain(LLAMACPP_FLEET_PORT);
    // A stopped unit of ours, or a hand-run server the CLI never pointed the Hub at: not this run's rule to add.
    expect(hubProbePortsFor(host({ managedUnits: { [LLAMACPP_UNIT]: 'inactive' } }), false)).not.toContain(LLAMACPP_FLEET_PORT);
    expect(
      hubProbePortsFor(host({ enginesListening: [LLAMACPP_FLEET_PORT], engineOwners: { [LLAMACPP_FLEET_PORT]: 'llamacpp' } }), false),
    ).not.toContain(LLAMACPP_FLEET_PORT);
  });
});
