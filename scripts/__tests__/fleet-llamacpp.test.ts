/**
 * llama-server on a fleet node: the image choice, Ollama's blob, the unit, and the two Hub halves.
 *
 * The pure parts (flavour, manifest path, args, classifiers) are asserted directly. The shells are
 * RUN, against stub `systemctl`/`docker`/`curl`/`getent` binaries and a temp Ollama store, because
 * the whole point of the apply is what it does on the second run: a node whose unit already carries
 * this spec must see nothing restarted, and a string match on the script cannot prove that.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { type HostFacts, parseHostFacts } from '../lib/fleet-hardware.js';
import {
  classifyHubLlamacppUrlOutput,
  classifyLlamacppApplyOutput,
  classifyLlamacppProbeOutput,
  describeLlamacppPublish,
  HUB_AUTO_MODEL_MARKERS,
  HUB_LLAMACPP_URL,
  hubAutoModelShell,
  hubLlamacppUrlShell,
  isSafeOllamaTag,
  LLAMACPP_FLEET_PORT,
  LLAMACPP_MARKERS,
  LLAMACPP_UNIT,
  llamacppApplyShell,
  llamacppFlavour,
  llamacppImage,
  llamacppProbeShell,
  llamacppServerArgs,
  type LlamacppSpec,
  ollamaManifestRelativePath,
  readLlamacppIdentity,
  readLlamacppPublish,
  resolveHubAutoModel,
} from '../lib/fleet-llamacpp.js';

const host = (over: Partial<HostFacts> = {}): HostFacts => ({
  os: 'linux',
  arch: 'x86_64',
  appleSilicon: false,
  docker: { present: true, usable: true },
  gpus: [],
  enginesListening: [],
  notes: [],
  ...over,
});
const strixHalo = { vendor: 'amd' as const, gfx: 'gfx1151', reportedVramMib: 2048, gttMib: 62061, driverWorking: true };
const rx7900 = { vendor: 'amd' as const, gfx: 'gfx1100', reportedVramMib: 24576, driverWorking: true };
const gfx1036 = { vendor: 'amd' as const, gfx: 'gfx1036', reportedVramMib: 512, driverWorking: true };
const gfx90c = { vendor: 'amd' as const, gfx: 'gfx90c', reportedVramMib: 512, driverWorking: true };
const nvidia = { vendor: 'nvidia' as const, name: 'RTX 3080', reportedVramMib: 10240, driverWorking: true };
const deadNvidia = { vendor: 'nvidia' as const, name: 'RTX 3070', driverWorking: false, driverNote: 'nvidia-smi did not answer' };

const spec: LlamacppSpec = { flavour: 'server-rocm', model: 'qwen3-coder:30b', parallel: 4, contextLength: 32768 };
const DIGEST = 'b'.repeat(64);

describe('the host probe', () => {
  it("reports who answers on :8081 and the managed unit's state, and omits both when the probe said nothing", () => {
    const facts = parseHostFacts(
      [
        'os=Linux',
        'arch=x86_64',
        'docker_version=Docker version 29.8.0',
        'docker_info=ok',
        'listening=11434',
        'listening=8081',
        'owner_8081=LLAMACPP',
        'unit_cihub-llamacpp.service=active',
      ].join('\n'),
    );
    expect(facts.enginesListening).toEqual([11434, 8081]);
    expect(facts.engineOwners).toEqual({ 8081: 'llamacpp' });
    expect(facts.managedUnits).toEqual({ 'cihub-llamacpp.service': 'active' });

    const bare = parseHostFacts(['os=Linux', 'arch=x86_64', 'listening=11434'].join('\n'));
    expect(bare.engineOwners).toBeUndefined();
    expect(bare.managedUnits).toBeUndefined();
    // `systemctl is-active` prints `inactive` for a unit it has never heard of: kept, since that is
    // also the state of a unit that exists and is stopped, and the planner treats both as not ours.
    expect(parseHostFacts('unit_cihub-llamacpp.service=inactive').managedUnits).toEqual({ 'cihub-llamacpp.service': 'inactive' });
    expect(parseHostFacts('unit_cihub-llamacpp.service=unknown').managedUnits).toBeUndefined();
  });
});

describe('image choice', () => {
  it('is ROCm on gfx11 (measured on gfx1151), Vulkan on other AMD parts, CUDA on NVIDIA, CPU otherwise', () => {
    expect(llamacppFlavour(host({ gpus: [strixHalo] })).flavour).toBe('server-rocm');
    expect(llamacppFlavour(host({ gpus: [rx7900] })).flavour).toBe('server-rocm');
    // gfx1036 is RDNA2 (10.3.6), not gfx11: unmeasured under ROCm here, so it gets the fallback.
    expect(llamacppFlavour(host({ gpus: [gfx1036] })).flavour).toBe('server-vulkan');
    expect(llamacppFlavour(host({ gpus: [gfx90c] })).flavour).toBe('server-vulkan');
    expect(llamacppFlavour(host({ gpus: [{ vendor: 'amd', driverWorking: true }] })).flavour).toBe('server-vulkan');
    expect(llamacppFlavour(host({ gpus: [nvidia] })).flavour).toBe('server-cuda');
    expect(llamacppFlavour(host()).flavour).toBe('server');
  });

  it('does not hand a dead NVIDIA driver the CUDA image', () => {
    // The card on the bus with no module loaded: `--gpus all` would fail the container at start.
    expect(llamacppFlavour(host({ gpus: [deadNvidia] })).flavour).toBe('server');
    expect(llamacppFlavour(host({ gpus: [deadNvidia, strixHalo] })).flavour).toBe('server-rocm');
  });

  it('pins the measured build rather than the floating tag', () => {
    expect(llamacppImage('server-rocm')).toBe('ghcr.io/ggml-org/llama.cpp:server-rocm-b11065');
    expect(llamacppImage('server')).toBe('ghcr.io/ggml-org/llama.cpp:server-b11065');
  });
});

describe("Ollama's store", () => {
  it('maps a tag to its manifest the way Ollama lays the store out', () => {
    expect(ollamaManifestRelativePath('qwen3-coder:30b')).toBe('manifests/registry.ollama.ai/library/qwen3-coder/30b');
    expect(ollamaManifestRelativePath('nomic-embed-text')).toBe('manifests/registry.ollama.ai/library/nomic-embed-text/latest');
    expect(ollamaManifestRelativePath('someone/custom:q4')).toBe('manifests/registry.ollama.ai/someone/custom/q4');
    expect(ollamaManifestRelativePath('hf.co/unsloth/Qwen3-30B-GGUF:Q4_K_M')).toBe('manifests/hf.co/unsloth/Qwen3-30B-GGUF/Q4_K_M');
  });

  it('refuses a tag that could escape the unit file or the manifest path', () => {
    for (const ok of ['qwen3-coder:30b', 'gemma4:e4b', 'hf.co/org/repo:Q4_K_M', 'a/b']) expect(isSafeOllamaTag(ok)).toBe(true);
    for (const bad of ['', '../etc', 'a b', "x'; rm -rf /", 'a:b:c', '$HOME', '-flag']) expect(isSafeOllamaTag(bad)).toBe(false);
  });
});

describe('the measured flags', () => {
  it('derives -np and -c from the slot count and per-slot window, and never enables speculative decoding', () => {
    const args = llamacppServerArgs({ parallel: 4, contextLength: 32768 });
    expect(args).toBe('-ngl 999 -fa on -np 4 -ub 2048 -b 2048 --cache-reuse 256 --jinja --metrics -c 131072');
    expect(llamacppServerArgs({ parallel: 2, contextLength: 16384 })).toContain('-np 2');
    expect(llamacppServerArgs({ parallel: 2, contextLength: 16384 })).toContain('-c 32768');
    expect(args).not.toMatch(/draft|spec/);
  });
});

describe('reading the shells back', () => {
  it('reads the identity lines, and leaves a field the server did not print undefined', () => {
    expect(readLlamacppIdentity('llamacpp-models: id=qwen3-coder:30b owned_by=llamacpp\nllamacpp-props: n_ctx=32768 total_slots=4')).toEqual({
      id: 'qwen3-coder:30b',
      ownedBy: 'llamacpp',
      nCtx: 32768,
      totalSlots: 4,
    });
    expect(readLlamacppIdentity('llamacpp-models: id=? owned_by=?\nllamacpp-props: n_ctx=? total_slots=?')).toEqual({});
    expect(readLlamacppIdentity('nothing here')).toBeUndefined();
  });

  it('classifies a probe: missing model, unchanged unit, and the ExecStart the dry run prints', () => {
    const missing = classifyLlamacppProbeOutput(
      [
        'llamacpp-models-dir: /mnt/cache/ollama',
        'llamacpp-model: missing qwen3-coder:30b — no manifest at /mnt/x (ollama pull qwen3-coder:30b on this node first)',
        'llamacpp-complete',
      ].join('\n'),
    );
    expect(missing.state).toBe('model-missing');
    expect(missing.why).toContain('ollama pull qwen3-coder:30b');

    const execStart =
      '/usr/bin/docker run --rm --name cihub-llamacpp -p 127.0.0.1:8081:8080 -p 100.64.0.6:8081:8080 -p 172.17.0.1:8081:8080 ghcr.io/ggml-org/llama.cpp:server-rocm-b11065';
    const ok = classifyLlamacppProbeOutput(
      [
        'llamacpp-models-dir: /mnt/cache/ollama',
        `llamacpp-model: qwen3-coder:30b sha256-${DIGEST}`,
        'llamacpp-publish: tailnet=100.64.0.6 gateway=172.17.0.1',
        'llamacpp-unit: unchanged',
        'llamacpp-unit-state: active',
        LLAMACPP_MARKERS.unitBegin,
        '[Service]',
        `ExecStart=${execStart}`,
        LLAMACPP_MARKERS.unitEnd,
        'llamacpp-models: id=qwen3-coder:30b owned_by=llamacpp',
        'llamacpp-props: n_ctx=32768 total_slots=4',
        'llamacpp-complete',
      ].join('\n'),
    );
    expect(ok).toMatchObject({ state: 'ok', blob: `sha256-${DIGEST}`, unit: 'unchanged', unitState: 'active', modelsDir: '/mnt/cache/ollama' });
    expect(ok.execStart).toBe(execStart);
    expect(ok.publish).toEqual({ tailnet: '100.64.0.6', gateway: '172.17.0.1' });
    expect(ok.server).toEqual({ id: 'qwen3-coder:30b', ownedBy: 'llamacpp', nCtx: 32768, totalSlots: 4 });
    expect(classifyLlamacppProbeOutput('').state).toBe('incomplete');
  });

  it('says which addresses the port is published on, and warns when the one the Hub needs is missing', () => {
    expect(readLlamacppPublish('llamacpp-publish: tailnet=? gateway=172.17.0.1')).toEqual({ tailnet: undefined, gateway: '172.17.0.1' });
    expect(readLlamacppPublish('nothing')).toBeUndefined();
    const full = describeLlamacppPublish({ tailnet: '100.64.0.6', gateway: '172.17.0.1' });
    expect(full.tone).toBe('dim');
    expect(full.text).toBe(
      "published on 127.0.0.1, 100.64.0.6 (tailnet), 172.17.0.1 (docker0 — host.docker.internal inside ci-hub); never on 0.0.0.0 — Docker's DNAT would bypass ufw and the port guard",
    );
    // No tailnet address only costs the operator's own curl; no docker0 gateway means the Hub reaches nothing.
    expect(describeLlamacppPublish({ gateway: '172.17.0.1' })).toMatchObject({ tone: 'dim', text: expect.stringContaining('127.0.0.1, 172.17.0.1') });
    const noGateway = describeLlamacppPublish({ tailnet: '100.64.0.6' });
    expect(noGateway.tone).toBe('yellow');
    expect(noGateway.text).toContain(`No docker0 gateway was found: ci-hub could not reach it at ${HUB_LLAMACPP_URL}`);
    expect(describeLlamacppPublish(undefined).tone).toBe('yellow');
  });

  it('never calls an apply done on the completion marker alone', () => {
    const base = [
      `llamacpp-model: qwen3-coder:30b sha256-${DIGEST}`,
      'llamacpp-unit: absent',
      'llamacpp-image: present',
      'llamacpp-restart: restarted (unit written)',
    ];
    expect(classifyLlamacppApplyOutput([...base, 'llamacpp-complete'].join('\n'), '', spec)).toMatchObject({
      outcome: 'failed',
      why: expect.stringContaining('/health'),
    });
    // Health ok but the wrong engine on the port.
    expect(
      classifyLlamacppApplyOutput(
        [...base, 'llamacpp-health: ok 20s', 'llamacpp-models: id=x owned_by=dflash', 'llamacpp-complete'].join('\n'),
        '',
        spec,
      ),
    ).toMatchObject({ outcome: 'failed', why: expect.stringContaining('names itself "dflash"') });
    // Right engine, wrong alias.
    expect(
      classifyLlamacppApplyOutput(
        [
          ...base,
          'llamacpp-health: ok 20s',
          'llamacpp-models: id=other:7b owned_by=llamacpp',
          'llamacpp-props: n_ctx=32768 total_slots=4',
          'llamacpp-complete',
        ].join('\n'),
        '',
        spec,
      ),
    ).toMatchObject({ outcome: 'failed', why: expect.stringContaining('not the alias qwen3-coder:30b') });
    // Right alias, wrong shape: the pool would place against slots that are not there.
    expect(
      classifyLlamacppApplyOutput(
        [
          ...base,
          'llamacpp-health: ok 20s',
          'llamacpp-models: id=qwen3-coder:30b owned_by=llamacpp',
          'llamacpp-props: n_ctx=16384 total_slots=8',
          'llamacpp-complete',
        ].join('\n'),
        '',
        spec,
      ),
    ).toMatchObject({ outcome: 'failed', why: expect.stringContaining('8 slots × 16384') });
    // The timeout carries the unit's journal tail, which is where a ROCm allocation failure shows.
    const timeout = classifyLlamacppApplyOutput(
      [
        ...base,
        'llamacpp-health: timeout 600s (unit activating, restarted 0 times, last /health 503)',
        'llamacpp-log: ggml_cuda_init: failed|exit 1',
        'llamacpp-complete',
      ].join('\n'),
      '',
      spec,
    );
    expect(timeout).toMatchObject({ outcome: 'failed', detail: `journalctl -u ${LLAMACPP_UNIT}: ggml_cuda_init: failed|exit 1` });
    expect(timeout.why).toContain('waited 600s');
    // A crash loop is named as one: the loop left after three automatic restarts, not after 600 s,
    // and "did not answer within 600 s" would send the operator looking at a slow disk.
    const loop = classifyLlamacppApplyOutput(
      [
        ...base,
        'llamacpp-health: crash-loop 15s (unit activating, restarted 3 times, last /health 000)',
        'llamacpp-log: error: unable to load model|exit 1|error: unable to load model|exit 1',
        'llamacpp-complete',
      ].join('\n'),
      '',
      spec,
    );
    expect(loop.outcome).toBe('failed');
    expect(loop.why).toBe(
      `llama-server is crash-looping: systemd restarted ${LLAMACPP_UNIT} 3 times in 15 s and /health never answered 200 (unit activating, last /health 000) — its journal is below`,
    );
    expect(loop.detail).toContain('unable to load model');
    expect(
      classifyLlamacppApplyOutput(
        [...base, 'llamacpp-health: unit-failed 10s (unit failed, restarted 0 times, last /health 000)', 'llamacpp-complete'].join('\n'),
        '',
        spec,
      ).why,
    ).toBe(`${LLAMACPP_UNIT} reached failed after 10 s (unit failed, last /health 000) — its journal is below`);
    expect(
      classifyLlamacppApplyOutput(
        'llamacpp-model: missing qwen3-coder:30b — no manifest at /x (ollama pull qwen3-coder:30b on this node first)\nllamacpp-complete',
        '',
        spec,
      ).why,
    ).toContain('no manifest');
    expect(
      classifyLlamacppApplyOutput(`llamacpp-model: x sha256-${DIGEST}\nllamacpp-image: pull-failed ghcr.io/x\nllamacpp-complete`, '', spec).why,
    ).toContain('docker pull');
    expect(classifyLlamacppApplyOutput('', '', spec).outcome).toBe('incomplete');
  });

  it('reports unchanged for a unit that already carried this spec, and applied with the load time otherwise', () => {
    const lines = (restart: string) =>
      [
        `llamacpp-model: qwen3-coder:30b sha256-${DIGEST}`,
        'llamacpp-image: present',
        `llamacpp-restart: ${restart}`,
        'llamacpp-health: ok 45s',
        'llamacpp-models: id=qwen3-coder:30b owned_by=llamacpp',
        'llamacpp-props: n_ctx=32768 total_slots=4',
        'llamacpp-complete',
      ].join('\n');
    const unchanged = classifyLlamacppApplyOutput(lines('not-needed'), '', spec);
    expect(unchanged.outcome).toBe('unchanged');
    expect(unchanged.why).toBe(
      `${LLAMACPP_UNIT} unchanged, not restarted; serving qwen3-coder:30b as 4 × 32768 (ghcr.io/ggml-org/llama.cpp:server-rocm-b11065)`,
    );
    const applied = classifyLlamacppApplyOutput(lines('restarted (unit written)'), '', spec);
    expect(applied.outcome).toBe('applied');
    expect(applied.why).toBe(
      `${LLAMACPP_UNIT} unit written, model loaded in 45 s; serving qwen3-coder:30b as 4 × 32768 (ghcr.io/ggml-org/llama.cpp:server-rocm-b11065)`,
    );
    expect(applied.server?.totalSlots).toBe(4);
  });
});

describe('the Hub half: LLAMACPP_URL', () => {
  const lines = (...rest: string[]) => ['hub-llamacpp-url-file: /home/ci/.local/share/companion-hub/.env.dev', ...rest].join('\n');

  it('is unchanged only when the RUNNING container carries the URL, not merely the file', () => {
    expect(
      classifyHubLlamacppUrlOutput(
        lines(
          'hub-llamacpp-url-now: http://host.docker.internal:8081',
          'hub-llamacpp-url-write: skipped',
          'hub-llamacpp-url-container: current',
          'hub-llamacpp-url-complete',
        ),
        '',
      ),
    ).toMatchObject({
      outcome: 'unchanged',
    });
    // The file had it from a cut-off run; the container did not. Recreated.
    const applied = classifyHubLlamacppUrlOutput(
      lines(
        'hub-llamacpp-url-now: http://host.docker.internal:8081',
        'hub-llamacpp-url-write: skipped',
        'hub-llamacpp-url-container: recreated',
        'hub-llamacpp-url-health: ok 12s',
        'hub-llamacpp-url-complete',
      ),
      '',
    );
    expect(applied.outcome).toBe('applied');
    expect(applied.why).toBe('LLAMACPP_URL already in /home/ci/.local/share/companion-hub/.env.dev; ci-hub recreated, live again after 12 s');
  });

  it('names the file it wrote and the previous value, and fails with the fix when nothing could recreate the Hub', () => {
    const noLabels = classifyHubLlamacppUrlOutput(
      lines(
        'hub-llamacpp-url-now: http://100.1.2.3:8081',
        'hub-llamacpp-url-write: written',
        'hub-llamacpp-url-container: no-compose-identity',
        'hub-llamacpp-url-complete',
      ),
      '',
    );
    expect(noLabels.outcome).toBe('failed');
    expect(noLabels.why).toContain(
      `LLAMACPP_URL=${HUB_LLAMACPP_URL} written to /home/ci/.local/share/companion-hub/.env.dev (was http://100.1.2.3:8081)`,
    );
    expect(noLabels.why).toContain('run `cihub up` on the node');
    expect(classifyHubLlamacppUrlOutput(lines('hub-llamacpp-url-write: no-env-file', 'hub-llamacpp-url-complete'), '').why).toContain(
      'is a Hub installed there?',
    );
    expect(
      classifyHubLlamacppUrlOutput(
        lines('hub-llamacpp-url-write: written', 'hub-llamacpp-url-container: mismatch none', 'hub-llamacpp-url-complete'),
        '',
      ).why,
    ).toContain('reads LLAMACPP_URL=none');
    expect(
      classifyHubLlamacppUrlOutput(
        lines(
          'hub-llamacpp-url-write: written',
          'hub-llamacpp-url-container: recreated',
          'hub-llamacpp-url-health: timeout 180s',
          'hub-llamacpp-url-complete',
        ),
        '',
      ).why,
    ).toContain('did not answer /api/health/live');
    expect(classifyHubLlamacppUrlOutput('', '').outcome).toBe('failed');
  });

  it('asks compose for the stack the container records, never a guessed project', () => {
    const shell = hubLlamacppUrlShell();
    expect(shell).toContain('com.docker.compose.project.environment_file');
    expect(shell).toContain('com.docker.compose.project.working_dir');
    expect(shell).toContain('com.docker.compose.project.config_files');
    expect(shell).toContain('up -d --no-build --no-deps');
    expect(shell).not.toContain('cihub up');
    expect(shell).not.toContain('--project-name ci-hub');
  });
});

describe('the default model: what the node’s Hub resolves auto to', () => {
  const m = HUB_AUTO_MODEL_MARKERS;
  const out = (prefs: unknown, profile: unknown, over: { key?: string; prefsHttp?: string; profileHttp?: string } = {}) =>
    [
      `${m.key} ${over.key ?? 'present'}`,
      `${m.prefsHttp} ${over.prefsHttp ?? '200'}`,
      m.prefsBegin,
      JSON.stringify(prefs),
      m.prefsEnd,
      `${m.profileHttp} ${over.profileHttp ?? '200'}`,
      m.profileBegin,
      JSON.stringify(profile),
      m.profileEnd,
      m.complete,
    ].join('\n');
  const profile = {
    recommendedModels: [
      { id: 'nomic-embed-text', backend: 'ollama', backendModelId: 'nomic-embed-text', modality: 'embedding' },
      { id: 'gemma4-e4b', backend: 'ollama', backendModelId: 'gemma4:e4b', modality: 'llm' },
      { id: 'qwen3-coder-30b', backend: 'ollama', backendModelId: 'qwen3-coder:30b', modality: 'llm' },
    ],
    availableModels: [{ id: 'qwen35-9b-vllm', backend: 'vllm', backendModelId: 'Qwen/Qwen3.5-9B', modality: 'llm' }],
    installedCatalogIds: ['nomic-embed-text', 'qwen3-coder-30b'],
  };

  it('maps the pinned catalog id to its Ollama tag', () => {
    // The fleet's shape: `auto` → qwen3-coder-30b on all 16, a catalog id, not a tag.
    expect(resolveHubAutoModel(out({ preferredModel: 'qwen3-coder-30b' }, profile))).toEqual({
      kind: 'ok',
      tag: 'qwen3-coder:30b',
      why: "this node's Hub pins qwen3-coder-30b for auto",
    });
  });

  it('falls back to the first recommended Ollama LLM that is installed when nothing is pinned', () => {
    // gemma4:e4b is recommended first but not installed; the embedder is installed but not an LLM.
    expect(resolveHubAutoModel(out({ preferredModel: null }, profile))).toMatchObject({ kind: 'ok', tag: 'qwen3-coder:30b' });
  });

  it('refuses to invent a tag: a pin the catalog cannot map, or one on another engine, names the flag', () => {
    expect(resolveHubAutoModel(out({ preferredModel: 'qwen35-9b-vllm' }, profile))).toMatchObject({
      kind: 'failed',
      why: expect.stringContaining('vllm row'),
    });
    expect(resolveHubAutoModel(out({ preferredModel: 'ghost' }, profile))).toMatchObject({
      kind: 'failed',
      why: expect.stringContaining('does not list'),
    });
    expect(resolveHubAutoModel(out({ preferredModel: null }, { ...profile, installedCatalogIds: [] }))).toMatchObject({
      kind: 'failed',
      why: expect.stringContaining('--llamacpp-model'),
    });
  });

  it('tells the four refusals apart, like the recommendation probe does', () => {
    expect(
      resolveHubAutoModel(out({}, profile, { key: 'missing' })).kind === 'failed' && resolveHubAutoModel(out({}, profile, { key: 'missing' })),
    ).toMatchObject({ why: expect.stringContaining('no device key') });
    expect(resolveHubAutoModel(out({}, profile, { prefsHttp: '000' }))).toMatchObject({ why: expect.stringContaining('nothing answered') });
    expect(resolveHubAutoModel(out({}, profile, { prefsHttp: '401' }))).toMatchObject({ why: expect.stringContaining('HTTP 401') });
    expect(resolveHubAutoModel(out({}, profile, { profileHttp: '409' }))).toMatchObject({ why: expect.stringContaining('cihub claim') });
    expect(resolveHubAutoModel('garbage')).toMatchObject({ kind: 'failed' });
    expect(
      resolveHubAutoModel(
        `${m.key} present\n${m.prefsHttp} 200\n${m.prefsBegin}\nnot json\n${m.prefsEnd}\n${m.profileHttp} 200\n${m.profileBegin}\n{}\n${m.profileEnd}\n${m.complete}`,
      ),
    ).toMatchObject({
      why: expect.stringContaining('not JSON'),
    });
  });

  it('never prints the key', () => {
    const shell = hubAutoModelShell('/var/lib/companion-hub');
    expect(shell).toContain('unset cihub_am_key');
    expect(shell).not.toMatch(/echo[^\n]*\$cihub_am_key/);
    expect(shell).toContain('/var/lib/companion-hub/state/settings.json');
  });
});

// ─── The shells, run ──────────────────────────────────────────────────────────

const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p));
describe.skipIf(!bash)('llamacppApplyShell / llamacppProbeShell (sandboxed bash)', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A node in a directory: an Ollama store with one manifest and its blob, a `systemctl` whose
   * `show ollama` names that store (core-6's shape), whose unit state lives in a file and whose
   * `is-active` exits non-zero for anything but `active` (as the real one does — the shape that
   * turned `$(systemctl is-active … || echo inactive)` into `inactive\ninactive`), a `docker` that
   * remembers whether the image was pulled, a `curl` that answers the server's three routes —
   * /health 503 until the unit is active, then 200 — and a `tailscale`/`ip` pair naming the two
   * addresses the unit publishes on beside loopback. `crashLoop` is a container that dies at start:
   * a restart leaves the unit `activating (auto-restart)` with NRestarts climbing and /health never
   * answering, and the journal holds what it printed.
   */
  function node(
    options: {
      storeInEnv?: boolean;
      manifest?: boolean;
      blob?: boolean;
      ownedBy?: string;
      alias?: string;
      nCtx?: number;
      slots?: number;
      crashLoop?: boolean;
      /** What `tailscale ip -4` prints; `''` is a node whose tailscaled is down (an error sentence). */
      tailnet?: string;
      /** What `ip -4 addr show docker0` prints; `false` is no docker0 at all (then Docker's own view of its bridge is asked). */
      docker0?: string | false;
    } = {},
  ) {
    const root = mkdtempSync(path.join(tmpdir(), 'cihub-llamacpp-'));
    sandboxes.push(root);
    const bin = path.join(root, 'bin');
    const units = path.join(root, 'units');
    const store = path.join(root, 'models');
    const log = path.join(root, 'calls.log');
    mkdirSync(bin);
    mkdirSync(units);
    mkdirSync(path.join(store, 'manifests', 'registry.ollama.ai', 'library', 'qwen3-coder'), { recursive: true });
    mkdirSync(path.join(store, 'blobs'));
    if (options.manifest !== false) {
      writeFileSync(
        path.join(store, 'manifests', 'registry.ollama.ai', 'library', 'qwen3-coder', '30b'),
        // Ollama's own layout, verified on core-6: one line, the license layer before the model layer.
        JSON.stringify({
          schemaVersion: 2,
          layers: [
            { mediaType: 'application/vnd.ollama.image.license', digest: `sha256:${'a'.repeat(64)}`, size: 11338 },
            { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${DIGEST}`, size: 18556688736 },
          ],
        }),
      );
    }
    if (options.blob !== false) writeFileSync(path.join(store, 'blobs', `sha256-${DIGEST}`), 'GGUF');
    const stub = (name: string, body: string) => {
      writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    const env =
      options.storeInEnv === false ? 'PATH=/usr/bin OLLAMA_HOST=0.0.0.0:11434' : `PATH=/usr/bin OLLAMA_MODELS=${store} OLLAMA_HOST=0.0.0.0:11434`;
    // A restart brings a healthy unit to `active`; a crash-looping one sits in `activating` with the
    // restart counter already past the threshold, the way `systemctl show` reads it mid-loop.
    const afterRestart = options.crashLoop ? `echo activating > "${root}/state"; echo 3 > "${root}/nrestarts"` : `echo active > "${root}/state"`;
    stub(
      'systemctl',
      [
        'case "$1" in',
        '  show) case "$*" in',
        `    *NRestarts*) cat "${root}/nrestarts" 2>/dev/null || echo 0 ;;`,
        `    *) echo "${env}" ;;`,
        '  esac ;;',
        // Real `is-active`: the state on stdout, exit 0 only for `active`.
        `  is-active) st="$(cat "${root}/state" 2>/dev/null)"; [ -n "$st" ] || st=inactive; echo "$st"; [ "$st" = active ] ;;`,
        `  restart) ${afterRestart} ;;`,
        '  enable) true ;;',
        'esac',
      ].join('\n'),
    );
    stub(
      'docker',
      [
        'case "$1" in',
        `  image) [ -e "${root}/image-present" ] ;;`,
        `  pull) touch "${root}/image-present" ;;`,
        // `docker run --rm` has removed a container that died: the real answer, verbatim.
        '  logs) echo "Error response from daemon: No such container: cihub-llamacpp" >&2; exit 1 ;;',
        `  network) echo "${options.docker0 === false ? '172.17.0.1' : ''}" ;;`,
        'esac',
      ].join('\n'),
    );
    // The unit's own output lives here — a container that dies at start is gone by the time anyone
    // asks `docker logs`, and this is what the real journal holds after three attempts.
    stub(
      'journalctl',
      options.crashLoop
        ? 'printf "%s\\n" "ggml_cuda_init: failed to initialize ROCm: no ROCm-capable device is detected" "error: unable to load model" "cihub-llamacpp.service: Main process exited, code=exited, status=1/FAILURE"'
        : 'echo "srv  load_model: loading model /models/blobs/sha256-..."',
    );
    // `tailscale ip -4` with tailscaled down prints a sentence, not an address; the unit must not carry it.
    stub('tailscale', options.tailnet === '' ? 'echo "Tailscale is stopped."; exit 1' : `echo "${options.tailnet ?? '100.64.0.6'}"`);
    stub(
      'ip',
      options.docker0 === false
        ? 'echo "Device \\"docker0\\" does not exist." >&2; exit 1'
        : `printf "%s\\n" "5: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN group default" "    inet ${options.docker0 ?? '172.17.0.1'}/16 brd 172.17.255.255 scope global docker0" "       valid_lft forever preferred_lft forever"`,
    );
    const models = JSON.stringify({
      object: 'list',
      data: [{ id: options.alias ?? 'qwen3-coder:30b', object: 'model', owned_by: options.ownedBy ?? 'llamacpp' }],
    });
    const props = JSON.stringify({
      default_generation_settings: { id: 0, n_ctx: options.nCtx ?? 32768, params: { n_predict: -1 } },
      total_slots: options.slots ?? 4,
    });
    stub(
      'curl',
      [
        'for a in "$@"; do case "$a" in',
        `  */health) if [ "$(cat "${root}/state" 2>/dev/null)" = active ]; then printf 200; else printf 503; fi; exit 0 ;;`,
        `  */v1/models) printf '%s' '${models}'; exit 0 ;;`,
        `  */props) printf '%s' '${props}'; exit 0 ;;`,
        'esac; done',
      ].join('\n'),
    );
    stub('getent', 'case "$2" in video) echo "video:x:44:ci" ;; render) echo "render:x:992:ci" ;; esac');
    // The apply sleeps between health polls; the stub answers 200 as soon as the unit is active, so
    // a real sleep would only ever run on the failure paths. Keep those fast too.
    stub('sleep', 'true');
    return {
      units,
      store,
      calls: () => (existsSync(log) ? readFileSync(log, 'utf-8') : ''),
      unit: () => (existsSync(path.join(units, LLAMACPP_UNIT)) ? readFileSync(path.join(units, LLAMACPP_UNIT), 'utf-8') : undefined),
      run: (script: string) =>
        spawnSync(bash as string, ['-c', script], {
          env: { PATH: `${bin}:/usr/bin:/bin`, HOME: '/tmp', CIHUB_SYSTEMD_UNIT_DIR: units },
          encoding: 'utf-8',
        }),
    };
  }

  it('installs on the first run, and on the second finds its own unit unchanged and restarts nothing', () => {
    const box = node();
    const first = box.run(llamacppApplyShell(spec));
    expect(first.status, first.stderr).toBe(0);
    const applied = classifyLlamacppApplyOutput(first.stdout, first.stderr, spec);
    expect(applied.outcome, first.stdout).toBe('applied');
    expect(applied.why).toContain('unit written, image pulled');
    expect(applied.server).toEqual({ id: 'qwen3-coder:30b', ownedBy: 'llamacpp', nCtx: 32768, totalSlots: 4 });

    // The unit: the blob resolved from the manifest, mounted read-only from the store `systemctl show`
    // named, the ROCm devices and the HOST's group ids, the alias, the measured flags.
    const unit = box.unit() ?? '';
    expect(unit).toContain(`-v ${box.store}:/models:ro`);
    expect(unit).toContain(`--model /models/blobs/sha256-${DIGEST} --alias qwen3-coder:30b`);
    expect(unit).toContain('--device /dev/kfd --device /dev/dri --group-add 44 --group-add 992 --security-opt seccomp=unconfined');
    // Published on loopback, the tailnet address and the docker0 gateway the node reported — three
    // `-p` entries, never a bare one (0.0.0.0, DNATed past ufw and the port guard, open to the LAN).
    expect(unit).toContain(
      `--name cihub-llamacpp -p 127.0.0.1:${LLAMACPP_FLEET_PORT}:8080 -p 100.64.0.6:${LLAMACPP_FLEET_PORT}:8080 -p 172.17.0.1:${LLAMACPP_FLEET_PORT}:8080 --device`,
    );
    expect(unit).not.toContain(` -p ${LLAMACPP_FLEET_PORT}:8080`);
    expect(unit).not.toContain('0.0.0.0:8081');
    expect(first.stdout).toContain('llamacpp-publish: tailnet=100.64.0.6 gateway=172.17.0.1');
    expect(unit).toContain('ghcr.io/ggml-org/llama.cpp:server-rocm-b11065');
    expect(unit).toContain('-np 4 -ub 2048 -b 2048 --cache-reuse 256 --jinja --metrics -c 131072');
    expect(unit).toMatch(/^Restart=always$/m);
    expect(box.calls()).toContain('docker pull ghcr.io/ggml-org/llama.cpp:server-rocm-b11065');
    expect(box.calls()).toContain('systemctl daemon-reload');
    expect(box.calls()).toContain(`systemctl restart ${LLAMACPP_UNIT}`);

    const before = box.calls();
    const second = box.run(llamacppApplyShell(spec));
    expect(second.status, second.stderr).toBe(0);
    const again = classifyLlamacppApplyOutput(second.stdout, second.stderr, spec);
    expect(again.outcome, second.stdout).toBe('unchanged');
    expect(again.why).toContain('not restarted');
    const delta = box.calls().slice(before.length);
    expect(delta).not.toContain('systemctl restart');
    expect(delta).not.toContain('docker pull');
    expect(delta).not.toContain('daemon-reload');
  });

  it('rewrites and restarts when the spec changes, and starts a unit whose bytes match but which is not running', () => {
    const box = node();
    box.run(llamacppApplyShell(spec));
    const before = box.calls();
    const res = box.run(llamacppApplyShell({ ...spec, parallel: 2, contextLength: 16384 }));
    // The stub server still answers 4 × 32768, so the read-back fails — which is the point of it.
    const outcome = classifyLlamacppApplyOutput(res.stdout, res.stderr, { ...spec, parallel: 2, contextLength: 16384 });
    expect(outcome.outcome).toBe('failed');
    expect(outcome.why).toContain('reads back 4 slots × 32768');
    expect(box.calls().slice(before.length)).toContain(`systemctl restart ${LLAMACPP_UNIT}`);
    expect(box.unit()).toContain('-np 2');
    expect(box.unit()).toContain('-c 32768');

    // Back to the spec the server answers; then stop the unit behind the CLI's back.
    box.run(llamacppApplyShell(spec));
    writeFileSync(path.join(box.units, '..', 'state'), 'inactive');
    const mid = box.calls();
    const restarted = box.run(llamacppApplyShell(spec));
    expect(classifyLlamacppApplyOutput(restarted.stdout, restarted.stderr, spec)).toMatchObject({
      outcome: 'applied',
      why: expect.stringContaining('unit unchanged but inactive'),
    });
    expect(box.calls().slice(mid.length)).toContain(`systemctl restart ${LLAMACPP_UNIT}`);
  });

  it('refuses by name a tag Ollama has not pulled, before touching the image or the unit', () => {
    const box = node({ manifest: false });
    const res = box.run(llamacppApplyShell(spec));
    expect(res.status).toBe(0);
    const outcome = classifyLlamacppApplyOutput(res.stdout, res.stderr, spec);
    expect(outcome.outcome).toBe('failed');
    expect(outcome.why).toContain('ollama pull qwen3-coder:30b on this node first');
    expect(box.calls()).not.toContain('docker pull');
    expect(box.unit()).toBeUndefined();

    const noBlob = node({ blob: false });
    expect(classifyLlamacppApplyOutput(noBlob.run(llamacppApplyShell(spec)).stdout, '', spec).why).toContain(`sha256-${DIGEST}`);
  });

  it("falls back to Ollama's default store when the daemon's environment names none", () => {
    const box = node({ storeInEnv: false });
    const res = box.run(llamacppProbeShell(spec));
    expect(res.stdout).toContain('llamacpp-models-dir: /usr/share/ollama/.ollama/models');
  });

  it('the probe renders the same unit the apply writes, reports unchanged against it, and installs nothing', () => {
    const box = node();
    box.run(llamacppApplyShell(spec));
    const before = box.calls();
    const res = box.run(llamacppProbeShell(spec));
    expect(res.status, res.stderr).toBe(0);
    const probe = classifyLlamacppProbeOutput(res.stdout);
    expect(probe).toMatchObject({ state: 'ok', unit: 'unchanged', unitState: 'active', blob: `sha256-${DIGEST}`, modelsDir: box.store });
    expect(probe.execStart).toContain('--alias qwen3-coder:30b');
    const delta = box.calls().slice(before.length);
    expect(delta).not.toMatch(/docker (pull|run)|systemctl (restart|enable|daemon-reload)/);
    expect(classifyLlamacppProbeOutput(box.run(llamacppProbeShell({ ...spec, parallel: 2 })).stdout).unit).toBe('differs');
  });

  it('fails a server that came up as somebody else', () => {
    const box = node({ ownedBy: 'dflash', alias: 'lucebox-model' });
    const res = box.run(llamacppApplyShell(spec));
    const outcome = classifyLlamacppApplyOutput(res.stdout, res.stderr, spec);
    expect(outcome.outcome).toBe('failed');
    expect(outcome.why).toContain('names itself "dflash"');
  });

  it('stops waiting on a crash loop after three automatic restarts and reports the journal, not a container docker has already removed', () => {
    // The unit is `docker run --rm` under Restart=always/RestartSec=5: a container that dies at start
    // is removed, restarted, removed again — `is-active` never reads `failed`, `docker logs` answers
    // "No such container", and a 600 s health wait per node is what the loop used to cost.
    const box = node({ crashLoop: true });
    const res = box.run(llamacppApplyShell(spec));
    expect(res.status, res.stderr).toBe(0);
    const outcome = classifyLlamacppApplyOutput(res.stdout, res.stderr, spec);
    expect(outcome.outcome).toBe('failed');
    expect(outcome.why).toContain(`crash-looping: systemd restarted ${LLAMACPP_UNIT} 3 times in 0 s`);
    expect(outcome.why).toContain('unit activating');
    expect(outcome.detail).toContain('ggml_cuda_init: failed to initialize ROCm');
    expect(outcome.detail).toContain('error: unable to load model');
    // One health poll, then the restart counter ended it — not 120 polls with a stubbed sleep.
    const healthPolls = box
      .calls()
      .split('\n')
      .filter((l) => l.startsWith('curl') && l.includes('/health'));
    expect(healthPolls).toHaveLength(1);
    expect(box.calls()).toContain(`systemctl show -p NRestarts --value ${LLAMACPP_UNIT}`);
    expect(box.calls()).toContain(`journalctl -u ${LLAMACPP_UNIT} -n 20 --no-pager -o cat`);
    expect(box.calls()).not.toContain('docker logs');
  });

  it('reads the unit state once: a real `is-active` prints inactive AND exits non-zero, and the marker must not read inactive twice', () => {
    // `$(systemctl is-active … || echo inactive)` yields `inactive\ninactive` against the real
    // command; the stub exits the way it does, so this would catch the shape coming back.
    const box = node();
    const res = box.run(llamacppProbeShell(spec));
    expect(res.stdout).toMatch(/^llamacpp-unit-state: inactive$/m);
    expect(res.stdout.split('\n').filter((l) => l === 'inactive')).toEqual([]);
    expect(classifyLlamacppProbeOutput(res.stdout).unitState).toBe('inactive');
    // The apply on a fresh node goes through the same read before it decides to write.
    const applied = box.run(llamacppApplyShell(spec));
    expect(applied.stdout).not.toContain('inactive\ninactive');
    expect(applied.stdout).toContain('llamacpp-restart: restarted (unit written)');
  });

  it('publishes on loopback alone when the node names no tailnet address and no docker0, and takes the gateway from Docker when the interface is missing', () => {
    // tailscaled down: `tailscale ip` prints a sentence, which must not land in a `-p`.
    const noTailnet = node({ tailnet: '' });
    const first = noTailnet.run(llamacppProbeShell(spec));
    expect(first.stdout).toContain('llamacpp-publish: tailnet=? gateway=172.17.0.1');
    const probe = classifyLlamacppProbeOutput(first.stdout);
    expect(probe.publish).toEqual({ tailnet: undefined, gateway: '172.17.0.1' });
    expect(probe.execStart).toContain('-p 127.0.0.1:8081:8080 -p 172.17.0.1:8081:8080 ');
    expect(probe.execStart).not.toContain('Tailscale');
    // No docker0 interface (a daemon on a custom bridge): Docker's own view of its default bridge.
    const noDocker0 = node({ docker0: false });
    const second = classifyLlamacppProbeOutput(noDocker0.run(llamacppProbeShell(spec)).stdout);
    expect(second.publish).toEqual({ tailnet: '100.64.0.6', gateway: '172.17.0.1' });
    expect(noDocker0.calls()).toContain('docker network inspect bridge');
    expect(describeLlamacppPublish(second.publish).tone).toBe('dim');
  });
});

describe.skipIf(!bash)('hubLlamacppUrlShell (sandboxed bash)', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A node whose `ci-hub` container records its compose identity in labels, and an env file with no LLAMACPP_URL. */
  function node(options: { labels?: boolean; envInitial?: string; running?: string } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'cihub-llamacpp-url-'));
    sandboxes.push(root);
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    const dataDir = path.join(home, '.local', 'share', 'companion-hub');
    const envFile = path.join(dataDir, '.env.dev');
    const log = path.join(root, 'calls.log');
    mkdirSync(bin);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(envFile, options.envInitial ?? 'API_PORT=5002\nCI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:dev');
    if (options.running) writeFileSync(path.join(root, 'running-url'), options.running);
    const labels = options.labels === false ? '' : 'yes';
    writeFileSync(
      path.join(bin, 'docker'),
      [
        '#!/bin/sh',
        `echo "docker $*" >> "${log}"`,
        'case "$1" in',
        '  inspect) case "$*" in',
        `    *environment_file*) [ -n "${labels}" ] && echo "${envFile}" || echo "<no value>" ;;`,
        `    *working_dir*) [ -n "${labels}" ] && echo "${dataDir}" || echo "<no value>" ;;`,
        `    *config_files*) [ -n "${labels}" ] && echo "${dataDir}/docker-compose.prod.yml,${dataDir}/docker-compose.override.yml" || echo "<no value>" ;;`,
        '    *compose.service*) echo ci-hub ;;',
        `    *compose.project\\"*) [ -n "${labels}" ] && echo ci-hub || echo "<no value>" ;;`,
        `    *Config.Env*) echo API_PORT=5002; [ -e "${root}/running-url" ] && echo "LLAMACPP_URL=$(cat "${root}/running-url")" ;;`,
        '    esac ;;',
        // A recreate reads the env file the way compose does, so the container's env reflects the file.
        `  compose) grep -h '^LLAMACPP_URL=' "${envFile}" | cut -d= -f2- > "${root}/running-url" ;;`,
        'esac',
      ].join('\n'),
    );
    chmodSync(path.join(bin, 'docker'), 0o755);
    writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nprintf 200\n');
    chmodSync(path.join(bin, 'curl'), 0o755);
    writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\ntrue\n');
    chmodSync(path.join(bin, 'sleep'), 0o755);
    return {
      envFile,
      env: () => readFileSync(envFile, 'utf-8'),
      calls: () => (existsSync(log) ? readFileSync(log, 'utf-8') : ''),
      run: () => spawnSync(bash as string, ['-c', hubLlamacppUrlShell()], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: 'utf-8' }),
    };
  }

  it('writes the key into the file compose reads, recreates only ci-hub from the recorded stack, and is a no-op the second time', () => {
    const box = node();
    const res = box.run();
    expect(res.status, res.stderr).toBe(0);
    const outcome = classifyHubLlamacppUrlOutput(res.stdout, res.stderr);
    expect(outcome.outcome, res.stdout).toBe('applied');
    expect(outcome.envFile).toBe(box.envFile);
    expect(box.env()).toBe(`API_PORT=5002\nCI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:dev\nLLAMACPP_URL=${HUB_LLAMACPP_URL}\n`);
    const compose =
      box
        .calls()
        .split('\n')
        .find((l) => l.startsWith('docker compose')) ?? '';
    expect(compose).toContain(`-p ci-hub --project-directory ${path.dirname(box.envFile)} --env-file ${box.envFile}`);
    expect(compose).toContain(
      `-f ${path.join(path.dirname(box.envFile), 'docker-compose.prod.yml')} -f ${path.join(path.dirname(box.envFile), 'docker-compose.override.yml')}`,
    );
    expect(compose).toContain('up -d --no-build --no-deps ci-hub');

    const again = box.run();
    expect(classifyHubLlamacppUrlOutput(again.stdout, again.stderr).outcome).toBe('unchanged');
    expect((box.calls().match(/docker compose/g) ?? []).length).toBe(1);
  });

  it('replaces a stale value in place and terminates a file with no trailing newline before appending', () => {
    const stale = node({ envInitial: 'LLAMACPP_URL=http://100.1.2.3:8081\nAPI_PORT=5002' });
    // The fleet's `.env.dev` is 0600 because it carries the Hub's secrets; a rewrite that swaps in a
    // fresh file would leave it at the umask's mode instead.
    chmodSync(stale.envFile, 0o600);
    expect(classifyHubLlamacppUrlOutput(stale.run().stdout, '')).toMatchObject({
      outcome: 'applied',
      why: expect.stringContaining('(was http://100.1.2.3:8081)'),
    });
    expect(stale.env()).toBe(`LLAMACPP_URL=${HUB_LLAMACPP_URL}\nAPI_PORT=5002\n`);
    expect(statSync(stale.envFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(stale.envFile))).toEqual(['.env.dev']);

    // The shape that produced `TRAEFIK_DASHBOARD_PORT=8080LEMONADE_URL=…` on two nodes.
    const unterminated = node({ envInitial: 'TRAEFIK_DASHBOARD_PORT=8080' });
    unterminated.run();
    expect(unterminated.env()).toBe(`TRAEFIK_DASHBOARD_PORT=8080\nLLAMACPP_URL=${HUB_LLAMACPP_URL}\n`);
  });

  it('recreates a Hub whose file already has the key but whose container does not (a cut-off run)', () => {
    const box = node({ envInitial: `API_PORT=5002\nLLAMACPP_URL=${HUB_LLAMACPP_URL}\n` });
    const outcome = classifyHubLlamacppUrlOutput(box.run().stdout, '');
    expect(outcome.outcome).toBe('applied');
    expect(outcome.why).toContain('LLAMACPP_URL already in');
    expect(box.calls()).toContain('docker compose');
  });

  it('writes the file but reports a failure with the fix when the container records no compose identity', () => {
    const box = node({ labels: false });
    const outcome = classifyHubLlamacppUrlOutput(box.run().stdout, '');
    expect(outcome.outcome).toBe('failed');
    expect(outcome.why).toContain('no compose labels');
    expect(box.env()).toContain(`LLAMACPP_URL=${HUB_LLAMACPP_URL}`);
    expect(box.calls()).not.toContain('docker compose');
  });
});
