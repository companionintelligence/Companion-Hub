/**
 * llama-server on a fleet node, serving the SAME GGUF its Ollama already holds.
 *
 * Measured 2026-09-21 on core-6 (Strix Halo, gfx1151) against the exact blob Ollama loads for
 * `qwen3-coder:30b`, with `ghcr.io/ggml-org/llama.cpp:server-rocm` build b11065 and the flags below
 * (4 slots × 32k): prefill 1096 tok/s on a 16.3k prompt against 529 for GPU-Ollama, decode 70.7 vs
 * 75, 146.5 tok/s aggregate over four streams at 0.86 s to first token, 9/9 well-formed tool calls
 * where Ollama managed 2/3 (ollama/ollama#18563), and a follow-up turn on a cached 16k prefix in
 * 0.11 s. ROCm loads fine there — no NO_VMM trouble at 33 GB GTT — so the ROCm image is first
 * choice on gfx11; the Vulkan image is the fallback (604 prefill, 81 decode, a 3-minute cold start).
 * Speculative decoding was a net loss and is deliberately not offered.
 *
 * Three decisions worth stating, because each one was the alternative that did not hold up:
 *
 * 1. **The model is Ollama's blob, mounted read-only — never a second download.** The Ollama store
 *    is resolved on the node (`OLLAMA_MODELS` from the daemon's own environment, then the account's,
 *    then Ollama's default) and the tag's manifest names the GGUF layer. Same bytes, no second copy
 *    of an 18 GB file, and a tag that is not pulled is refused by name before anything runs.
 * 2. **Port 8081, not llama-server's own 8080.** 8080 is mlx-dspark's default AND the Traefik
 *    dashboard on every appliance — `ss` shows it taken on a node that runs no llama-server at all.
 *    `LLAMACPP_URL` in the Hub is opt-in for the same collision; the fleet writes it explicitly.
 * 3. **One systemd unit running one container, restarted only when its bytes change.** The unit is
 *    rendered on the node from facts the node knows (group ids, the docker binary, the blob), then
 *    compared with what is installed. Identical bytes on an active unit run nothing — a restart
 *    unloads the model, and a fleet command WILL be re-run.
 *
 * NOTHING HERE RUNS ANYTHING. The shells are executed by `cihub fleet backends --execute`.
 */

import type { HostFacts } from './fleet-hardware.js';

/** Host port the fleet's llama-server listens on. 8080 belongs to dspark and to Traefik's dashboard. */
export const LLAMACPP_FLEET_PORT = 8081;
/** llama-server's own listen port INSIDE the container; the unit publishes it on {@link LLAMACPP_FLEET_PORT}. */
export const LLAMACPP_CONTAINER_PORT = 8080;
export const LLAMACPP_UNIT = 'cihub-llamacpp.service';
export const LLAMACPP_UNIT_DIR = '/etc/systemd/system';
export const LLAMACPP_UNIT_PATH = `${LLAMACPP_UNIT_DIR}/${LLAMACPP_UNIT}`;
export const LLAMACPP_CONTAINER = 'cihub-llamacpp';
export const LLAMACPP_IMAGE_REPO = 'ghcr.io/ggml-org/llama.cpp';
/** The build measured. Pinned: the floating `server-rocm` tag moves with every upstream merge. */
export const LLAMACPP_IMAGE_BUILD = 'b11065';
/** Where the Hub container reaches the unit's published port. Written to the node's env file after an install. */
export const HUB_LLAMACPP_URL = `http://host.docker.internal:${LLAMACPP_FLEET_PORT}`;
/** Ollama's default store when the daemon's environment names none (the system unit's home). */
export const OLLAMA_DEFAULT_MODELS_DIR = '/usr/share/ollama/.ollama/models';

/** The measured defaults: four slots of 32k each. `--ollama-parallel` / `--ollama-context` override them. */
export const LLAMACPP_DEFAULT_PARALLEL = 4;
export const LLAMACPP_DEFAULT_CONTEXT = 32768;

/** The upstream image variants this file chooses between. */
export type LlamacppFlavour = 'server-rocm' | 'server-vulkan' | 'server-cuda' | 'server';

export interface LlamacppFlavourChoice {
  flavour: LlamacppFlavour;
  /** One clause for the plan line: which GPU decided it. */
  why: string;
}

/**
 * Which image a machine gets. AMD gfx11 → ROCm, measured; any other AMD or an unknown AMD target →
 * Vulkan, the fallback that loads everywhere; NVIDIA with a live driver → CUDA; nothing → the CPU
 * image, which serves but is not what anyone benchmarks.
 */
export function llamacppFlavour(facts: HostFacts): LlamacppFlavourChoice {
  const nvidia = facts.gpus.find((g) => g.vendor === 'nvidia' && g.driverWorking);
  if (nvidia) return { flavour: 'server-cuda', why: `NVIDIA GPU${nvidia.name ? ` (${nvidia.name})` : ''} — CUDA image` };
  const amd = facts.gpus.find((g) => g.vendor === 'amd');
  if (amd) {
    if (amd.gfx && /^gfx11/.test(amd.gfx)) return { flavour: 'server-rocm', why: `AMD ${amd.gfx} — ROCm image (measured on gfx1151)` };
    return { flavour: 'server-vulkan', why: `AMD ${amd.gfx ?? 'GPU'} — Vulkan image (ROCm is only measured on gfx11)` };
  }
  return { flavour: 'server', why: 'no supported GPU — CPU image' };
}

export function llamacppImage(flavour: LlamacppFlavour): string {
  return `${LLAMACPP_IMAGE_REPO}:${flavour}-${LLAMACPP_IMAGE_BUILD}`;
}

/** What one node's llama-server is asked to run. Pure data; the shells are rendered from it. */
export interface LlamacppSpec {
  flavour: LlamacppFlavour;
  /** The Ollama tag whose blob is served, and the `--alias` `/v1/models` reports. */
  model: string;
  /** `-np`: slots. */
  parallel: number;
  /** Per-slot window; `-c` is `parallel × contextLength`, which is how llama-server divides it. */
  contextLength: number;
}

/**
 * Where Ollama keeps a tag's manifest, relative to the models dir.
 *
 * `qwen3-coder:30b` → `manifests/registry.ollama.ai/library/qwen3-coder/30b`; a namespaced tag keeps
 * its namespace under the same registry; a tag whose first segment carries a dot is a host
 * (`hf.co/org/repo:Q4_K_M`) and is stored under that host. No tag → `latest`, as Ollama does.
 */
export function ollamaManifestRelativePath(tag: string): string {
  const trimmed = tag.trim();
  const colon = trimmed.lastIndexOf(':');
  const slashAfterColon = colon >= 0 && trimmed.indexOf('/', colon) >= 0;
  const name = colon >= 0 && !slashAfterColon ? trimmed.slice(0, colon) : trimmed;
  const version = colon >= 0 && !slashAfterColon ? trimmed.slice(colon + 1) || 'latest' : 'latest';
  const segments = name.split('/').filter(Boolean);
  const path =
    segments.length === 1
      ? ['registry.ollama.ai', 'library', segments[0]]
      : segments[0]?.includes('.')
        ? segments
        : ['registry.ollama.ai', ...segments];
  return ['manifests', ...path, version].join('/');
}

/** An Ollama tag as the shells and the unit may carry it: nothing that could escape a quote or a path. */
export function isSafeOllamaTag(tag: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*(:[A-Za-z0-9._-]+)?$/.test(tag) && !tag.includes('..');
}

/** The measured flags, minus the model and the listen address, which the unit supplies. */
export function llamacppServerArgs(spec: Pick<LlamacppSpec, 'parallel' | 'contextLength'>): string {
  return [
    '-ngl 999',
    '-fa on',
    `-np ${spec.parallel}`,
    '-ub 2048',
    '-b 2048',
    '--cache-reuse 256',
    '--jinja',
    '--metrics',
    `-c ${spec.parallel * spec.contextLength}`,
  ].join(' ');
}

/**
 * The devices and groups each image needs. Group ids are resolved on the node (`getent`) rather
 * than named: `--group-add video` is looked up in the CONTAINER's /etc/group, where the id may
 * differ or the group may not exist, while a numeric id is passed through as-is. ROCm needs the
 * KFD node and the render nodes; Vulkan the render nodes; CUDA the runtime hook; the CPU image nothing.
 */
export function llamacppGpuFlagsShell(flavour: LlamacppFlavour): string[] {
  const groups = [
    'cihub_lc_video="$(getent group video 2>/dev/null | cut -d: -f3)"',
    'cihub_lc_render="$(getent group render 2>/dev/null | cut -d: -f3)"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion for the generated script, not a forgotten template literal — JS must NOT interpolate it.
    'cihub_lc_groups="${cihub_lc_video:+ --group-add $cihub_lc_video}${cihub_lc_render:+ --group-add $cihub_lc_render}"',
  ];
  switch (flavour) {
    case 'server-rocm':
      return [...groups, 'cihub_lc_gpu=" --device /dev/kfd --device /dev/dri$cihub_lc_groups --security-opt seccomp=unconfined"'];
    case 'server-vulkan':
      return [...groups, 'cihub_lc_gpu=" --device /dev/dri$cihub_lc_groups"'];
    case 'server-cuda':
      return ['cihub_lc_gpu=" --gpus all"'];
    case 'server':
      return ['cihub_lc_gpu=""'];
  }
}

export const LLAMACPP_MARKERS = {
  modelsDir: 'llamacpp-models-dir:',
  model: 'llamacpp-model:',
  /** `unchanged` / `differs` / `absent` — the rendered unit against the installed one. */
  unit: 'llamacpp-unit:',
  unitState: 'llamacpp-unit-state:',
  image: 'llamacpp-image:',
  /** `not-needed` / `restarted (<why>)`. */
  restart: 'llamacpp-restart:',
  health: 'llamacpp-health:',
  log: 'llamacpp-log:',
  models: 'llamacpp-models:',
  props: 'llamacpp-props:',
  unitBegin: '===LLAMACPP-UNIT===',
  unitEnd: '===END===',
  complete: 'llamacpp-complete',
} as const;

/**
 * Resolve the tag to Ollama's blob and render the unit into `$cihub_lc_tmp`, printing what was found.
 *
 * Shared by the read-only probe and the privileged apply, so the two render the SAME bytes — the
 * dry run's "unchanged" is only worth printing if the apply would agree. Every finding is a marker
 * line; a resolution that fails prints its marker and returns 1 so the caller can stop.
 */
function llamacppRenderShell(spec: LlamacppSpec): string[] {
  const m = LLAMACPP_MARKERS;
  const image = llamacppImage(spec.flavour);
  const manifest = ollamaManifestRelativePath(spec.model);
  return [
    // Overridable so the sandboxed test can install into a temp dir. On a node `sudo -n bash` resets
    // the environment, so the apply always sees the default; the unprivileged probe inherits the
    // account's environment, where nothing sets it.
    `cihub_lc_unit="\${CIHUB_SYSTEMD_UNIT_DIR:-${LLAMACPP_UNIT_DIR}}/${LLAMACPP_UNIT}"`,
    'cihub_lc_resolve() {',
    // The daemon's own environment first: core-6 keeps its store on /mnt/cache/ollama through a
    // systemd drop-in, and nothing else on the box would say so.
    `  cihub_lc_models="$(systemctl show ollama -p Environment --value 2>/dev/null | tr ' ' '\\n' | sed -n 's/^OLLAMA_MODELS=//p' | head -1)"`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion for the generated script, not a forgotten template literal — JS must NOT interpolate it.
    '  [ -n "$cihub_lc_models" ] || cihub_lc_models="${OLLAMA_MODELS:-}"',
    `  [ -n "$cihub_lc_models" ] || cihub_lc_models='${OLLAMA_DEFAULT_MODELS_DIR}'`,
    `  echo "${m.modelsDir} $cihub_lc_models"`,
    `  cihub_lc_manifest="$cihub_lc_models/${manifest}"`,
    '  if [ ! -e "$cihub_lc_manifest" ]; then',
    `    echo "${m.model} missing ${spec.model} — no manifest at $cihub_lc_manifest (ollama pull ${spec.model} on this node first)"`,
    '    return 1',
    '  fi',
    '  if [ ! -r "$cihub_lc_manifest" ]; then',
    `    echo "${m.model} unreadable ${spec.model} — $cihub_lc_manifest exists but this account cannot read it"`,
    '    return 1',
    '  fi',
    // Whitespace stripped, objects split, the model layer picked by its media type, its digest read.
    // Tolerates any key order and any pretty-printing; the closing quote keeps `image.model` from
    // matching `image.model.something` should Ollama ever add one.
    `  cihub_lc_digest="$(tr -d ' \\n\\t\\r' < "$cihub_lc_manifest" | grep -o '{[^{}]*}' | grep '"mediaType":"application/vnd.ollama.image.model"' | head -1 | grep -o 'sha256:[0-9a-f]\\{64\\}' | head -1 | cut -d: -f2)"`,
    '  if [ -z "$cihub_lc_digest" ]; then',
    `    echo "${m.model} unreadable ${spec.model} — the manifest at $cihub_lc_manifest names no GGUF layer"`,
    '    return 1',
    '  fi',
    '  cihub_lc_blob="$cihub_lc_models/blobs/sha256-$cihub_lc_digest"',
    '  if [ ! -e "$cihub_lc_blob" ]; then',
    `    echo "${m.model} missing ${spec.model} — the manifest names sha256-$cihub_lc_digest but $cihub_lc_blob is not there (ollama pull ${spec.model} again)"`,
    '    return 1',
    '  fi',
    `  echo "${m.model} ${spec.model} sha256-$cihub_lc_digest"`,
    ...llamacppGpuFlagsShell(spec.flavour).map((l) => `  ${l}`),
    '  cihub_lc_docker="$(command -v docker 2>/dev/null || echo /usr/bin/docker)"',
    '  cihub_lc_tmp="$(mktemp)"',
    // Unquoted heredoc on purpose: the node's values are what the unit must carry. Nothing else in
    // the unit starts with `$`.
    '  cat >"$cihub_lc_tmp" <<CIHUB_LLAMACPP_UNIT',
    '[Unit]',
    "Description=llama-server for the Companion Hub (managed by cihub fleet backends; the model is Ollama's own blob)",
    'After=docker.service network-online.target',
    'Requires=docker.service',
    '',
    '[Service]',
    'Type=simple',
    'Restart=always',
    'RestartSec=5',
    'TimeoutStartSec=0',
    'TimeoutStopSec=90',
    `ExecStartPre=-$cihub_lc_docker rm -f ${LLAMACPP_CONTAINER}`,
    `ExecStart=$cihub_lc_docker run --rm --name ${LLAMACPP_CONTAINER} -p ${LLAMACPP_FLEET_PORT}:${LLAMACPP_CONTAINER_PORT}$cihub_lc_gpu -v $cihub_lc_models:/models:ro ${image} --model /models/blobs/sha256-$cihub_lc_digest --alias ${spec.model} --host 0.0.0.0 --port ${LLAMACPP_CONTAINER_PORT} ${llamacppServerArgs(spec)}`,
    `ExecStop=$cihub_lc_docker stop -t 60 ${LLAMACPP_CONTAINER}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'CIHUB_LLAMACPP_UNIT',
    `  if [ ! -e "$cihub_lc_unit" ]; then echo "${m.unit} absent"`,
    `  elif cmp -s "$cihub_lc_tmp" "$cihub_lc_unit"; then echo "${m.unit} unchanged"`,
    `  else echo "${m.unit} differs"; fi`,
    `  echo "${m.unitState} $(systemctl is-active ${LLAMACPP_UNIT} 2>/dev/null || echo inactive)"`,
    '  return 0',
    '}',
  ];
}

/** The two GETs a running llama-server answers with its identity and its shape, as marker lines. */
function llamacppIdentityShell(): string[] {
  const m = LLAMACPP_MARKERS;
  const base = `http://127.0.0.1:${LLAMACPP_FLEET_PORT}`;
  return [
    `cihub_lc_body="$(curl -s --max-time 10 ${base}/v1/models 2>/dev/null)"`,
    `cihub_lc_owner="$(printf '%s' "$cihub_lc_body" | grep -o '"owned_by":"[^"]*"' | head -1 | cut -d'"' -f4)"`,
    `cihub_lc_id="$(printf '%s' "$cihub_lc_body" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"`,
    `echo "${m.models} id=\${cihub_lc_id:-?} owned_by=\${cihub_lc_owner:-?}"`,
    `cihub_lc_props="$(curl -s --max-time 10 ${base}/props 2>/dev/null | tr -d ' \\n\\t\\r')"`,
    // `n_ctx` sits before the first nested object of default_generation_settings; total_slots is top-level.
    `cihub_lc_nctx="$(printf '%s' "$cihub_lc_props" | grep -o '"default_generation_settings":{[^{}]*' | grep -o '"n_ctx":[0-9]*' | head -1 | cut -d: -f2)"`,
    `cihub_lc_slots="$(printf '%s' "$cihub_lc_props" | grep -o '"total_slots":[0-9]*' | head -1 | cut -d: -f2)"`,
    `echo "${m.props} n_ctx=\${cihub_lc_nctx:-?} total_slots=\${cihub_lc_slots:-?}"`,
  ];
}

/**
 * Read-only: what the node has, and whether this spec would change it. Unprivileged — reads the
 * model store, renders the unit to a temp file, compares, asks the server on :8081 who it is.
 * Prints the rendered unit between markers so the dry run can show the exact `docker run`.
 */
export function llamacppProbeShell(spec: LlamacppSpec): string {
  const m = LLAMACPP_MARKERS;
  return [
    'set +e',
    ...llamacppRenderShell(spec),
    'if cihub_lc_resolve; then',
    `  echo "${m.unitBegin}"`,
    '  cat "$cihub_lc_tmp"',
    `  echo "${m.unitEnd}"`,
    '  rm -f "$cihub_lc_tmp"',
    'fi',
    `if (echo > /dev/tcp/127.0.0.1/${LLAMACPP_FLEET_PORT}) >/dev/null 2>&1; then`,
    ...llamacppIdentityShell().map((l) => `  ${l}`),
    'fi',
    `echo "${m.complete}"`,
    'true',
  ].join('\n');
}

/** How long the apply waits for `/health` to turn 200: a cold Vulkan start measured 3 minutes; a bigger blob or a slower disk needs more. */
export const LLAMACPP_HEALTH_WAIT_S = 600;

/**
 * Privileged: pull the image if absent, install the unit if its bytes differ, restart only then
 * (or start a unit that is not running), wait for the model to load, and read back who is serving.
 *
 * Markers, not exit codes, like the runtime and firewall shells: the classifier below turns them
 * into an outcome, and "unchanged" is one — a node whose unit is already this unit and whose
 * server already answers is reported as such and nothing on it is restarted.
 */
export function llamacppApplyShell(spec: LlamacppSpec): string {
  const m = LLAMACPP_MARKERS;
  const image = llamacppImage(spec.flavour);
  return [
    'set +e',
    ...llamacppRenderShell(spec),
    `cihub_lc_resolve || { echo "${m.complete}"; exit 0; }`,
    `if docker image inspect '${image}' >/dev/null 2>&1; then echo "${m.image} present"`,
    `elif docker pull '${image}' >/dev/null 2>&1; then echo "${m.image} pulled"`,
    `else echo "${m.image} pull-failed ${image}"; rm -f "$cihub_lc_tmp"; echo "${m.complete}"; exit 0; fi`,
    `cihub_lc_active="$(systemctl is-active ${LLAMACPP_UNIT} 2>/dev/null || echo inactive)"`,
    `if cmp -s "$cihub_lc_tmp" "$cihub_lc_unit" && [ "$cihub_lc_active" = active ]; then`,
    `  echo "${m.restart} not-needed"`,
    'else',
    `  if cmp -s "$cihub_lc_tmp" "$cihub_lc_unit"; then cihub_lc_reason="unit unchanged but $cihub_lc_active"; else cihub_lc_reason="unit written"; fi`,
    `  install -m 0644 "$cihub_lc_tmp" "$cihub_lc_unit"`,
    '  systemctl daemon-reload',
    `  systemctl enable ${LLAMACPP_UNIT} >/dev/null 2>&1`,
    `  systemctl restart ${LLAMACPP_UNIT}`,
    `  echo "${m.restart} restarted ($cihub_lc_reason)"`,
    'fi',
    'rm -f "$cihub_lc_tmp"',
    // `/health` is 503 while the GGUF is still being mapped, which is the whole reason to poll it
    // rather than the port: a server that accepts a connection and then makes the first request wait
    // minutes is not up.
    'cihub_lc_waited=0',
    'cihub_lc_code=000',
    `while [ "$cihub_lc_waited" -lt ${LLAMACPP_HEALTH_WAIT_S} ]; do`,
    `  cihub_lc_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${LLAMACPP_FLEET_PORT}/health 2>/dev/null)"`,
    '  [ "$cihub_lc_code" = 200 ] && break',
    // A unit that has already died is not going to answer; say so now rather than in ten minutes.
    `  if [ "$(systemctl is-active ${LLAMACPP_UNIT} 2>/dev/null)" = failed ]; then break; fi`,
    '  sleep 5',
    '  cihub_lc_waited=$((cihub_lc_waited + 5))',
    'done',
    'if [ "$cihub_lc_code" = 200 ]; then',
    `  echo "${m.health} ok \${cihub_lc_waited}s"`,
    'else',
    `  echo "${m.health} timeout \${cihub_lc_waited}s (unit $(systemctl is-active ${LLAMACPP_UNIT} 2>/dev/null || echo inactive), last /health \${cihub_lc_code:-000})"`,
    `  echo "${m.log} $(docker logs --tail 6 ${LLAMACPP_CONTAINER} 2>&1 | tr '\\n' '|' | cut -c1-600)"`,
    `  echo "${m.complete}"`,
    '  exit 0',
    'fi',
    ...llamacppIdentityShell(),
    `echo "${m.complete}"`,
    'true',
  ].join('\n');
}

// ─── Reading the shells back ─────────────────────────────────────────────────

export interface LlamacppServerIdentity {
  id?: string;
  ownedBy?: string;
  nCtx?: number;
  totalSlots?: number;
}

const pickMarker = (lines: readonly string[], marker: string): string | undefined =>
  lines
    .find((l) => l.startsWith(marker))
    ?.slice(marker.length)
    .trim();

/** The `llamacpp-models:` and `llamacpp-props:` lines, when a server answered. */
export function readLlamacppIdentity(out: string): LlamacppServerIdentity | undefined {
  const lines = out.split('\n').map((l) => l.trim());
  const models = pickMarker(lines, LLAMACPP_MARKERS.models);
  const props = pickMarker(lines, LLAMACPP_MARKERS.props);
  if (models === undefined && props === undefined) return undefined;
  const field = (text: string | undefined, key: string): string | undefined => {
    const match = text ? new RegExp(`(?:^|\\s)${key}=(\\S*)`).exec(text) : null;
    const value = match?.[1];
    return value === undefined || value === '?' || value === '' ? undefined : value;
  };
  const number = (raw: string | undefined): number | undefined => (raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined);
  return {
    id: field(models, 'id'),
    ownedBy: field(models, 'owned_by'),
    nCtx: number(field(props, 'n_ctx')),
    totalSlots: number(field(props, 'total_slots')),
  };
}

export interface LlamacppProbeResult {
  /** `ok` — the tag resolved and a unit was rendered. `model-missing` / `model-unreadable` — it did not, and `why` says so. `incomplete` — the probe did not run to its marker. */
  state: 'ok' | 'model-missing' | 'model-unreadable' | 'incomplete';
  why: string;
  modelsDir?: string;
  blob?: string;
  /** Against the installed unit: `absent`, `unchanged`, `differs`. */
  unit?: 'absent' | 'unchanged' | 'differs';
  unitState?: string;
  /** The rendered unit's `ExecStart=` line, so a dry run shows the exact command. */
  execStart?: string;
  /** Whoever answered on :8081, when something did. */
  server?: LlamacppServerIdentity;
}

export function classifyLlamacppProbeOutput(out: string): LlamacppProbeResult {
  const lines = out.split('\n').map((l) => l.trim());
  const m = LLAMACPP_MARKERS;
  const server = readLlamacppIdentity(out);
  if (!lines.includes(m.complete)) return { state: 'incomplete', why: 'the llama-server probe produced no completion marker', server };
  const modelsDir = pickMarker(lines, m.modelsDir);
  const model = pickMarker(lines, m.model) ?? '';
  if (model.startsWith('missing ')) return { state: 'model-missing', why: model.slice('missing '.length), modelsDir, server };
  if (model.startsWith('unreadable ')) return { state: 'model-unreadable', why: model.slice('unreadable '.length), modelsDir, server };
  const blob = model.split(/\s+/)[1];
  const unitRaw = pickMarker(lines, m.unit);
  const unit = unitRaw === 'absent' || unitRaw === 'unchanged' || unitRaw === 'differs' ? unitRaw : undefined;
  const begin = out.indexOf(`${m.unitBegin}\n`);
  const end = begin >= 0 ? out.indexOf(`\n${m.unitEnd}`, begin) : -1;
  const rendered = begin >= 0 && end > begin ? out.slice(begin + m.unitBegin.length + 1, end) : '';
  const execStart = rendered
    .split('\n')
    .find((l) => l.startsWith('ExecStart='))
    ?.slice('ExecStart='.length);
  return { state: 'ok', why: `resolved ${model}`, modelsDir, blob, unit, unitState: pickMarker(lines, m.unitState), execStart, server };
}

export interface LlamacppApplyOutcome {
  outcome: 'applied' | 'unchanged' | 'failed' | 'incomplete';
  why: string;
  detail?: string;
  server?: LlamacppServerIdentity;
}

/**
 * Classify {@link llamacppApplyShell}'s output. `applied` and `unchanged` are printed only for a
 * server that answered `/health` 200 AND named itself `llamacpp` under the requested alias AND
 * reads back the requested slots and per-slot window — a unit that came up serving something
 * else is a failure with the difference in the sentence.
 */
export function classifyLlamacppApplyOutput(out: string, err: string, spec: LlamacppSpec): LlamacppApplyOutcome {
  const lines = `${out}\n${err}`.split('\n').map((l) => l.trim());
  const m = LLAMACPP_MARKERS;
  const server = readLlamacppIdentity(out);
  if (!lines.includes(m.complete)) return { outcome: 'incomplete', why: 'the llama-server step produced no completion marker' };
  const model = pickMarker(lines, m.model) ?? '';
  if (model.startsWith('missing ') || model.startsWith('unreadable ')) return { outcome: 'failed', why: model.replace(/^(missing|unreadable) /, '') };
  const image = pickMarker(lines, m.image) ?? '';
  if (image.startsWith('pull-failed'))
    return { outcome: 'failed', why: `docker pull ${llamacppImage(spec.flavour)} failed — is ghcr.io reachable from this node?` };
  const restart = pickMarker(lines, m.restart) ?? '';
  const health = pickMarker(lines, m.health) ?? '';
  if (!health.startsWith('ok')) {
    const log = pickMarker(lines, m.log);
    return {
      outcome: 'failed',
      why: `llama-server did not answer /health 200 within ${LLAMACPP_HEALTH_WAIT_S} s${health ? ` (${health.replace(/^timeout /, 'waited ')})` : ''}`,
      detail: log || undefined,
    };
  }
  if (server?.ownedBy !== 'llamacpp') {
    return {
      outcome: 'failed',
      why: `something answers on :${LLAMACPP_FLEET_PORT} but names itself "${server?.ownedBy ?? '?'}" on /v1/models, not llamacpp`,
      server,
    };
  }
  if (server.id !== spec.model) {
    return { outcome: 'failed', why: `llama-server reports model "${server.id ?? '?'}" on /v1/models, not the alias ${spec.model}`, server };
  }
  if (server.totalSlots !== spec.parallel || server.nCtx !== spec.contextLength) {
    return {
      outcome: 'failed',
      why: `llama-server reads back ${server.totalSlots ?? '?'} slots × ${server.nCtx ?? '?'} context on /props, not the ${spec.parallel} × ${spec.contextLength} requested`,
      server,
    };
  }
  const serving = `serving ${spec.model} as ${spec.parallel} × ${spec.contextLength} (${llamacppImage(spec.flavour)})`;
  if (restart === 'not-needed') return { outcome: 'unchanged', why: `${LLAMACPP_UNIT} unchanged, not restarted; ${serving}`, server };
  const waited = /ok (\d+)s/.exec(health)?.[1];
  return {
    outcome: 'applied',
    why: `${LLAMACPP_UNIT} ${restart.replace(/^restarted \((.*)\)$/, '$1') || 'written'}, ${image === 'pulled' ? 'image pulled, ' : ''}model loaded in ${waited ?? '?'} s; ${serving}`,
    server,
  };
}

// ─── The Hub's half: LLAMACPP_URL in the node's env file ────────────────────

export const HUB_LLAMACPP_URL_MARKERS = {
  file: 'hub-llamacpp-url-file:',
  now: 'hub-llamacpp-url-now:',
  write: 'hub-llamacpp-url-write:',
  container: 'hub-llamacpp-url-container:',
  health: 'hub-llamacpp-url-health:',
  complete: 'hub-llamacpp-url-complete',
} as const;

/** How long to wait for a recreated Hub to answer its liveness route. */
export const HUB_RECREATE_WAIT_S = 180;

/**
 * Tell the node's Hub where llama-server is: `LLAMACPP_URL` in the env file compose actually reads,
 * then the Hub container recreated so it starts with it.
 *
 * The URL is environment-only in the Hub (see `llamacpp.backend.ts`: it is opt-in precisely because
 * 8080 is shared, and there is no Settings field for it), so it is set the way the fleet already
 * sets `LEMONADE_URL` and `DSPARK_URL` for out-of-band engines: a line in `.env.dev` and a recreate.
 * The file is the one the `ci-hub` container's `com.docker.compose.project.environment_file` label
 * names — on this fleet `~/.local/share/companion-hub/.env.dev`, while a guess of `.env` would land
 * in a file compose never opens (see `cli-image-pin.ts`) — and the recreate uses the project, working
 * directory and compose files the same labels record, so it replaces THIS stack rather than creating
 * a second one from a guessed project name (see `compose-discovery.ts` for the five ways a guess went
 * wrong). Unprivileged: the file is the account's and the account is in `docker`.
 *
 * Nothing is recreated when the running container already carries the URL: `docker inspect` is
 * asked, not the file, because a line that was written and never applied is exactly the state a
 * cut-off run leaves. Every finding is a marker line; the exit status is always 0.
 */
export function hubLlamacppUrlShell(url: string = HUB_LLAMACPP_URL): string {
  const m = HUB_LLAMACPP_URL_MARKERS;
  const safe = url.replace(/'/g, "'\\''");
  const label = (name: string) => `docker inspect ci-hub --format '{{ index .Config.Labels "${name}" }}' 2>/dev/null | sed 's/<no value>//'`;
  return [
    'set +e',
    `cihub_lu_url='${safe}'`,
    `cihub_lu_env="$(${label('com.docker.compose.project.environment_file')})"`,
    'if [ -z "$cihub_lu_env" ]; then',
    '  cihub_lu_env="$HOME/.local/share/companion-hub/.env.dev"',
    '  [ -f "$cihub_lu_env" ] || cihub_lu_env="$HOME/.local/share/companion-hub/.env"',
    'fi',
    `echo "${m.file} $cihub_lu_env"`,
    `if [ ! -f "$cihub_lu_env" ]; then echo "${m.write} no-env-file"; echo "${m.complete}"; exit 0; fi`,
    `if [ ! -w "$cihub_lu_env" ]; then echo "${m.write} unwritable"; echo "${m.complete}"; exit 0; fi`,
    `cihub_lu_now="$(grep -h '^LLAMACPP_URL=' "$cihub_lu_env" 2>/dev/null | tail -1 | cut -d= -f2-)"`,
    `echo "${m.now} \${cihub_lu_now:-none}"`,
    `cihub_lu_running="$(docker inspect ci-hub --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^LLAMACPP_URL=//p' | head -1)"`,
    'if [ "$cihub_lu_now" = "$cihub_lu_url" ] && [ "$cihub_lu_running" = "$cihub_lu_url" ]; then',
    `  echo "${m.write} skipped"; echo "${m.container} current"; echo "${m.complete}"; exit 0`,
    'fi',
    'if [ "$cihub_lu_now" = "$cihub_lu_url" ]; then',
    `  echo "${m.write} skipped"`,
    'else',
    // A file with no trailing newline is how `TRAEFIK_DASHBOARD_PORT=8080LEMONADE_URL=…` happened
    // on two nodes (heal-hub-ports.ts): terminate it before appending. Replace in place when the key
    // is there, so the file keeps its order and its comments.
    `  [ -z "$(tail -c1 "$cihub_lu_env")" ] || printf '\\n' >>"$cihub_lu_env"`,
    '  if grep -q \'^LLAMACPP_URL=\' "$cihub_lu_env"; then',
    `    sed -i "s|^LLAMACPP_URL=.*|LLAMACPP_URL=$cihub_lu_url|" "$cihub_lu_env"`,
    '  else',
    `    printf 'LLAMACPP_URL=%s\\n' "$cihub_lu_url" >>"$cihub_lu_env"`,
    '  fi',
    `  echo "${m.write} written"`,
    'fi',
    `cihub_lu_project="$(${label('com.docker.compose.project')})"`,
    `cihub_lu_wd="$(${label('com.docker.compose.project.working_dir')})"`,
    `cihub_lu_files="$(${label('com.docker.compose.project.config_files')})"`,
    `cihub_lu_service="$(${label('com.docker.compose.service')})"`,
    'if [ -z "$cihub_lu_project" ] || [ -z "$cihub_lu_wd" ] || [ -z "$cihub_lu_files" ]; then',
    `  echo "${m.container} no-compose-identity"; echo "${m.complete}"; exit 0`,
    'fi',
    'set -- -p "$cihub_lu_project" --project-directory "$cihub_lu_wd" --env-file "$cihub_lu_env"',
    'cihub_lu_ifs="$IFS"; IFS=,',
    'for cihub_lu_f in $cihub_lu_files; do set -- "$@" -f "$cihub_lu_f"; done',
    'IFS="$cihub_lu_ifs"',
    // `--no-build`: the image is the artifact. `--no-deps`: traefik and the databases are not part of
    // this change. Compose recreates the service because its environment differs from the container's.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion for the generated script, not a forgotten template literal — JS must NOT interpolate it.
    'if ! docker compose "$@" up -d --no-build --no-deps "${cihub_lu_service:-ci-hub}" >/dev/null 2>&1; then',
    `  echo "${m.container} compose-failed"; echo "${m.complete}"; exit 0`,
    'fi',
    `cihub_lu_after="$(docker inspect ci-hub --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^LLAMACPP_URL=//p' | head -1)"`,
    `if [ "$cihub_lu_after" = "$cihub_lu_url" ]; then echo "${m.container} recreated"; else echo "${m.container} mismatch \${cihub_lu_after:-none}"; fi`,
    'cihub_lu_waited=0; cihub_lu_code=000',
    // The port the Hub was actually given: a heal that moved API_PORT once left a 5002 probe silent.
    `cihub_lu_port="$(grep -h '^API_PORT=' "$cihub_lu_env" 2>/dev/null | tail -1 | cut -d= -f2)"; [ -n "$cihub_lu_port" ] || cihub_lu_port=5002`,
    `while [ "$cihub_lu_waited" -lt ${HUB_RECREATE_WAIT_S} ]; do`,
    `  cihub_lu_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$cihub_lu_port/api/health/live" 2>/dev/null)"`,
    '  [ "$cihub_lu_code" = 200 ] && break',
    '  sleep 3; cihub_lu_waited=$((cihub_lu_waited + 3))',
    'done',
    `if [ "$cihub_lu_code" = 200 ]; then echo "${m.health} ok \${cihub_lu_waited}s"; else echo "${m.health} timeout \${cihub_lu_waited}s"; fi`,
    `echo "${m.complete}"`,
    'true',
  ].join('\n');
}

export interface HubLlamacppUrlOutcome {
  outcome: 'applied' | 'unchanged' | 'failed';
  why: string;
  envFile?: string;
}

export function classifyHubLlamacppUrlOutput(out: string, err: string, url: string = HUB_LLAMACPP_URL): HubLlamacppUrlOutcome {
  const lines = `${out}\n${err}`.split('\n').map((l) => l.trim());
  const m = HUB_LLAMACPP_URL_MARKERS;
  const envFile = pickMarker(lines, m.file);
  if (!lines.includes(m.complete)) return { outcome: 'failed', why: 'the Hub env step produced no completion marker', envFile };
  const write = pickMarker(lines, m.write);
  if (write === 'no-env-file')
    return { outcome: 'failed', why: `no Hub env file on the node (looked for ${envFile}) — is a Hub installed there?`, envFile };
  if (write === 'unwritable') return { outcome: 'failed', why: `${envFile} is not writable by this account`, envFile };
  const container = pickMarker(lines, m.container) ?? '';
  const now = pickMarker(lines, m.now);
  if (container === 'current') return { outcome: 'unchanged', why: `LLAMACPP_URL=${url} already in ${envFile} and in the running ci-hub`, envFile };
  const wrote =
    write === 'written'
      ? `LLAMACPP_URL=${url} written to ${envFile}${now && now !== 'none' ? ` (was ${now})` : ''}`
      : `LLAMACPP_URL already in ${envFile}`;
  if (container === 'no-compose-identity') {
    return {
      outcome: 'failed',
      why: `${wrote}; the ci-hub container carries no compose labels, so it was not recreated — run \`cihub up\` on the node to start the Hub with it`,
      envFile,
    };
  }
  if (container === 'compose-failed') {
    return {
      outcome: 'failed',
      why: `${wrote}; docker compose up failed to recreate ci-hub — run \`cihub up\` on the node and read its output`,
      envFile,
    };
  }
  if (container.startsWith('mismatch')) {
    return {
      outcome: 'failed',
      why: `${wrote}; ci-hub was recreated but reads LLAMACPP_URL=${container.slice('mismatch '.length) || 'none'} — compose did not take the env file it was given`,
      envFile,
    };
  }
  const health = pickMarker(lines, m.health) ?? '';
  if (!health.startsWith('ok')) {
    return {
      outcome: 'failed',
      why: `${wrote}; ci-hub recreated with it but did not answer /api/health/live within ${HUB_RECREATE_WAIT_S} s`,
      envFile,
    };
  }
  return { outcome: 'applied', why: `${wrote}; ci-hub recreated, live again after ${/ok (\d+)s/.exec(health)?.[1] ?? '?'} s`, envFile };
}

/** The dry-run line under a llamacpp plan. */
export function describeHubLlamacppUrlPlan(url: string = HUB_LLAMACPP_URL): string {
  return `hub: would set LLAMACPP_URL=${url} in the env file compose reads and recreate ci-hub, unless the running Hub already carries it`;
}

// ─── The default model: what the node's Hub resolves `auto` to ──────────────

export const HUB_AUTO_MODEL_MARKERS = {
  key: 'hub-auto-model-key:',
  prefsHttp: 'hub-auto-model-prefs-http:',
  prefsBegin: 'hub-auto-model-prefs-begin',
  prefsEnd: 'hub-auto-model-prefs-end',
  profileHttp: 'hub-auto-model-profile-http:',
  profileBegin: 'hub-auto-model-profile-begin',
  profileEnd: 'hub-auto-model-profile-end',
  complete: 'hub-auto-model-complete',
} as const;

/**
 * Ask the node's Hub which model it hands out for `auto`, so `--llamacpp-model` has a default that
 * is the node's own answer rather than a fleet-wide guess.
 *
 * Two reads, both over the node's loopback with its own device key (same lookup as
 * `hubRecommendationScript`, never printed): `preferredModel` from the inference preferences — the
 * pin `auto` resolves to first, a CATALOG id such as `qwen3-coder-30b` — and the onboarding profile,
 * whose catalog rows map that id to the Ollama tag (`backendModelId`) llama-server needs. When no
 * model is pinned, the first recommended Ollama LLM that is installed is what `auto` falls back to.
 */
export function hubAutoModelShell(dataDir = '/var/lib/companion-hub'): string {
  const hostSettings = `${dataDir.replace(/'/g, "'\\''")}/state/settings.json`;
  const m = HUB_AUTO_MODEL_MARKERS;
  return [
    'set +e',
    'cihub_am_key=""',
    "if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx ci-hub; then",
    `  cihub_am_key="$(docker exec ci-hub node -e 'try{const s=require("/data/state/settings.json");process.stdout.write(String(s.ciHubApiKey||""))}catch{}' 2>/dev/null)"`,
    'fi',
    `if [ -z "$cihub_am_key" ] && [ -r '${hostSettings}' ]; then`,
    `  cihub_am_key="$(sed -n 's/.*"ciHubApiKey"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' '${hostSettings}' | head -1)"`,
    'fi',
    `if [ -n "$cihub_am_key" ]; then echo "${m.key} present"; else echo "${m.key} missing"; fi`,
    'cihub_am_body="$(mktemp)"',
    `cihub_am_curl() { curl -s -o "$cihub_am_body" -w '%{http_code}' --max-time 30 -H "Authorization: Bearer $cihub_am_key" "$@" 2>/dev/null; }`,
    `cihub_am_code="$(cihub_am_curl http://127.0.0.1:5002/api/inference/preferences)"; [ -n "$cihub_am_code" ] || cihub_am_code=000`,
    `echo "${m.prefsHttp} $cihub_am_code"`,
    `echo "${m.prefsBegin}"; cat "$cihub_am_body" 2>/dev/null; echo; echo "${m.prefsEnd}"`,
    `cihub_am_code="$(cihub_am_curl http://127.0.0.1:5002/api/inference/onboarding-profile)"; [ -n "$cihub_am_code" ] || cihub_am_code=000`,
    `echo "${m.profileHttp} $cihub_am_code"`,
    `echo "${m.profileBegin}"; cat "$cihub_am_body" 2>/dev/null; echo; echo "${m.profileEnd}"`,
    'rm -f "$cihub_am_body"; unset cihub_am_key',
    `echo "${m.complete}"`,
    'true',
  ].join('\n');
}

export type HubAutoModel = { kind: 'ok'; tag: string; why: string } | { kind: 'failed'; why: string };

interface CatalogRowShape {
  id?: string;
  backend?: string;
  backendModelId?: string;
  modality?: string;
}

/**
 * Turn the two bodies into an Ollama tag, or a reason. Pure.
 *
 * The same precedence `resolveAutoModel` uses on the Hub, as far as two reads can follow it: the
 * pinned `preferredModel` when it is an Ollama row the catalog knows; else the first recommended
 * Ollama LLM the Hub reports installed. Neither is invented here — a Hub that pins a model the
 * catalog cannot map, or recommends nothing installed, is a reason to pass `--llamacpp-model`.
 */
export function resolveHubAutoModel(out: string): HubAutoModel {
  const m = HUB_AUTO_MODEL_MARKERS;
  const lines = out.split('\n').map((l) => l.trim());
  if (!lines.includes(m.complete)) return { kind: 'failed', why: 'the Hub could not be asked (no completion marker from the node)' };
  if (pickMarker(lines, m.key) !== 'present') {
    return {
      kind: 'failed',
      why: 'no device key on the node (neither in the ci-hub container nor in the host data dir) — is a Hub installed there?',
    };
  }
  const section = (begin: string, end: string): string => {
    const b = out.indexOf(`${begin}\n`);
    const e = b >= 0 ? out.indexOf(`\n${end}`, b) : -1;
    return b >= 0 && e > b ? out.slice(b + begin.length + 1, e).trim() : '';
  };
  const status = (marker: string, route: string): string | undefined => {
    const code = Number((pickMarker(lines, marker) ?? '000').slice(0, 3));
    if (code === 200) return undefined;
    if (code === 0) return `nothing answered on 127.0.0.1:5002 (${route}) — is the Hub running?`;
    if (code === 401) return `the Hub did not accept the node's device key (${route} HTTP 401)`;
    if (code === 409) return `the Hub is not claimed (${route} HTTP 409) — run cihub claim there first`;
    return `${route} answered HTTP ${code}`;
  };
  const prefsError = status(m.prefsHttp, 'GET /api/inference/preferences');
  if (prefsError) return { kind: 'failed', why: prefsError };
  const profileError = status(m.profileHttp, 'GET /api/inference/onboarding-profile');
  if (profileError) return { kind: 'failed', why: profileError };
  let prefs: { preferredModel?: unknown };
  let profile: { recommendedModels?: CatalogRowShape[]; availableModels?: CatalogRowShape[]; installedCatalogIds?: string[] };
  try {
    prefs = JSON.parse(section(m.prefsBegin, m.prefsEnd)) as typeof prefs;
    profile = JSON.parse(section(m.profileBegin, m.profileEnd)) as typeof profile;
  } catch {
    return { kind: 'failed', why: 'the Hub answered HTTP 200 with a body that is not JSON' };
  }
  const rows = [...(profile.recommendedModels ?? []), ...(profile.availableModels ?? [])];
  const installed = new Set(profile.installedCatalogIds ?? []);
  const preferred = typeof prefs.preferredModel === 'string' && prefs.preferredModel ? prefs.preferredModel : undefined;
  if (preferred) {
    const row = rows.find((r) => r.id === preferred);
    if (row?.backend === 'ollama' && row.backendModelId) {
      return { kind: 'ok', tag: row.backendModelId, why: `this node's Hub pins ${preferred} for auto` };
    }
    return {
      kind: 'failed',
      why: row
        ? `this node's Hub pins ${preferred} for auto, which is a ${row.backend ?? 'non-Ollama'} row with no Ollama tag — name the tag with --llamacpp-model`
        : `this node's Hub pins ${preferred} for auto, a catalog id its onboarding profile does not list — name the tag with --llamacpp-model`,
    };
  }
  const fallback = (profile.recommendedModels ?? []).find(
    (r) => r.backend === 'ollama' && r.backendModelId && r.modality === 'llm' && r.id && installed.has(r.id),
  );
  if (fallback?.backendModelId)
    return { kind: 'ok', tag: fallback.backendModelId, why: "this node's Hub pins nothing; its first installed recommended LLM" };
  return {
    kind: 'failed',
    why: "this node's Hub pins no model for auto and recommends no installed Ollama LLM — name the tag with --llamacpp-model",
  };
}
