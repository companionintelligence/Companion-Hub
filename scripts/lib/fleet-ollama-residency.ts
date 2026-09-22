/**
 * Where a resident model actually lives — GPU or CPU — read from Ollama's `/api/ps`.
 *
 * MEASURED 2026-09-21 on the bill-co fleet: six Strix Halo nodes (ci, core-4, core-6, core-14,
 * core-17, fzzy) served qwen3-coder:30b with `size_vram: 0` — 37.5 tok/s decode, 109 tok/s prefill —
 * and every probe that asks "is it up" was green. The managed bind file forced
 * `OLLAMA_LLM_LIBRARY=vulkan` (correct: ROCm NO_VMM cannot allocate there), but
 * `OLLAMA_IGPU_ENABLE=1` lived in the runtime file and only when `--ollama-igpu on` was passed, and
 * Ollama 0.34's runner drops an integrated GPU without it ("dropping integrated GPU; to enable, set
 * OLLAMA_IGPU_ENABLE=1"). With the key, the same nodes do 75–79 tok/s and ~530 tok/s prefill. The
 * fix is in `ollamaManagedEnvironment`; this file is the check that would have caught it — and
 * catches the next thing that parks a model on the CPU behind an HTTP 200.
 *
 * Two readings and one judgement, kept apart on purpose:
 *   · `/api/ps` says what is loaded and how much of it is in VRAM. It is asked at the bind the node
 *     resolves for itself, like `/api/version`, because several nodes here answer nothing on loopback.
 *   · The same round trip reads the two environment keys that decide the vulkan/iGPU trap, as the
 *     daemon resolved them, and whether the box has a GPU at all — a CPU-only node running a model
 *     on the CPU is not a finding.
 *   · {@link judgeOllamaResidency} is pure: a model with less than half its bytes in VRAM on a node
 *     with a GPU is resident on the CPU, and the reason is named when the environment explains it.
 *
 * Everything here is a read. Nothing installs, configures or restarts.
 */

import { decodeGfx, type HostFacts, isIntegratedAmdGpu } from './fleet-hardware.js';
import { OLLAMA_API_PORT, OLLAMA_RESOLVE_HOST_SH } from './fleet-ollama-version.js';
import { parseShowEnvironment } from './fleet-ollama-bind.js';
import type { FleetNode } from './fleet-roster.js';
import { classifySshFailure, type SshFailure, sshCapture, type SshTarget } from './fleet-ssh.js';

export const RESIDENCY_PROBE_MARKER = 'ollama-ps-probe=1';

/** One model `/api/ps` reports as loaded. Sizes are bytes, exactly as Ollama reports them. */
export interface OllamaLoadedModel {
  name: string;
  size: number;
  sizeVram: number;
  contextLength?: number;
}

/** The GPU the node's own probe saw. `present` false is a CPU-only box; absent means nobody looked. */
export interface ResidencyGpu {
  present: boolean;
  /** An AMD APU — the part Ollama drops without `OLLAMA_IGPU_ENABLE=1`. */
  integratedAmd: boolean;
  /** `nvidia`, `amd/gfx1151`, `none`. For a report line. */
  label: string;
}

export interface OllamaResidencyReading {
  /** Roster name, so a summary can name the machine. */
  node: string;
  /** The bind `/api/ps` was read from. */
  host?: string;
  /** Every model resident at the moment of reading. Absent whenever `/api/ps` could not be read. */
  models?: OllamaLoadedModel[];
  /** The two keys that decide the vulkan/iGPU trap, as `systemctl show` resolved them. Absent on a remote read. */
  env?: { llmLibrary?: string; igpuEnable?: string };
  /** What the node's probe saw. Absent on a remote read, where nothing on the box can be asked. */
  gpu?: ResidencyGpu;
  /** `node`: resolved on the machine over SSH. `remote`: `:11434` dialled from here, when SSH could not. */
  source?: 'node' | 'remote';
  /** Why there are no models. Set exactly when `models` is absent. */
  reason?: string;
}

/**
 * Ask a node what its Ollama has loaded, and where.
 *
 * Prints the marker, `ollama-ps-host=`, the merged environment, the GPU evidence, and then exactly
 * one of `ollama-ps-body=` (the `/api/ps` JSON on one line) or `ollama-ps-error=`. Always exits 0:
 * a non-zero exit here would be indistinguishable from SSH failing, and the two are different
 * findings. The GPU lines are the hardware probe's own commands, so the two never disagree about
 * what a box is.
 */
export function ollamaResidencyScript(): string {
  return [
    ...OLLAMA_RESOLVE_HOST_SH,
    `echo "${RESIDENCY_PROBE_MARKER}"`,
    'echo "ollama-ps-host=$host"',
    // As the daemon resolved it — every drop-in merged, last assignment winning. Never a file's contents.
    'echo "ollama-ps-env=$(systemctl show ollama -p Environment 2>/dev/null | sed \'s/^Environment=//\')"',
    'echo "ollama-ps-nvidia=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"',
    // Node 0 of the KFD topology is the CPU and reports 0; the first non-zero target is the GPU.
    'echo "ollama-ps-amd-gfx=$(grep -h gfx_target_version /sys/class/kfd/kfd/topology/nodes/*/properties 2>/dev/null | awk \'$2 > 0 {print $2; exit}\')"',
    'body="$(curl -fsS --max-time 5 "http://$host/api/ps" 2>/dev/null)" || body=""',
    'if [ -z "$body" ]; then echo "ollama-ps-error=nothing answered at $host/api/ps"; exit 0; fi',
    'echo "ollama-ps-body=$(printf \'%s\' "$body" | tr -d \'\\n\\r\')"',
    'exit 0',
  ].join('\n');
}

/** `/api/ps` as Ollama shapes it. Only the fields this file reads; anything else is ignored. */
interface OllamaPsBody {
  models?: Array<{ name?: unknown; model?: unknown; size?: unknown; size_vram?: unknown; context_length?: unknown }>;
}

const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Parse an `/api/ps` body. Never throws; a body that is not the shape returns `undefined`. */
export function parseOllamaPsBody(text: string): OllamaLoadedModel[] | undefined {
  let doc: OllamaPsBody;
  try {
    doc = JSON.parse(text) as OllamaPsBody;
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.models)) return undefined;
  const models: OllamaLoadedModel[] = [];
  for (const m of doc.models) {
    if (!m || typeof m !== 'object') continue;
    const name = typeof m.name === 'string' && m.name ? m.name : typeof m.model === 'string' ? m.model : '';
    if (!name) continue;
    const ctx = asNumber(m.context_length);
    models.push({ name, size: asNumber(m.size), sizeVram: asNumber(m.size_vram), ...(ctx ? { contextLength: ctx } : {}) });
  }
  return models;
}

/** Parse {@link ollamaResidencyScript} output. Never throws; garbage becomes a reason. */
export function parseOllamaResidencyOutput(out: string): Omit<OllamaResidencyReading, 'node' | 'source'> {
  let host: string | undefined;
  let env: OllamaResidencyReading['env'];
  let gpu: ResidencyGpu | undefined;
  let nvidia = '';
  let amdGfxRaw = '';
  let body: string | undefined;
  let reason: string | undefined;
  let present = false;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === RESIDENCY_PROBE_MARKER) present = true;
    else if (trimmed.startsWith('ollama-ps-host=')) host = trimmed.slice('ollama-ps-host='.length) || undefined;
    else if (trimmed.startsWith('ollama-ps-env=')) {
      const merged = parseShowEnvironment(`Environment=${trimmed.slice('ollama-ps-env='.length)}`);
      env = { llmLibrary: merged.OLLAMA_LLM_LIBRARY, igpuEnable: merged.OLLAMA_IGPU_ENABLE };
    } else if (trimmed.startsWith('ollama-ps-nvidia=')) nvidia = trimmed.slice('ollama-ps-nvidia='.length).trim();
    else if (trimmed.startsWith('ollama-ps-amd-gfx=')) amdGfxRaw = trimmed.slice('ollama-ps-amd-gfx='.length).trim();
    else if (trimmed.startsWith('ollama-ps-body=')) body = trimmed.slice('ollama-ps-body='.length);
    else if (trimmed.startsWith('ollama-ps-error=')) reason = trimmed.slice('ollama-ps-error='.length) || 'unspecified error';
  }
  if (!present) {
    return { reason: out.trim() ? `unrecognised probe output: ${out.trim().slice(0, 120)}` : 'the residency probe printed nothing' };
  }
  const gfx = decodeGfx(amdGfxRaw || undefined);
  if (nvidia && nvidia !== 'none') gpu = { present: true, integratedAmd: false, label: 'nvidia' };
  else if (gfx) gpu = { present: true, integratedAmd: isIntegratedAmdGpu({ vendor: 'amd', gfx }), label: `amd/${gfx}` };
  else gpu = { present: false, integratedAmd: false, label: 'none' };

  if (body !== undefined) {
    const models = parseOllamaPsBody(body);
    if (models) return { host, models, env, gpu };
    return { host, env, gpu, reason: `unparseable /api/ps body: ${body.slice(0, 120)}` };
  }
  return { host, env, gpu, reason: reason ?? 'the residency probe printed neither a body nor an error' };
}

/** The GPU half of a judgement, from the hardware facts `fleet backends` already read. */
export function residencyGpuFromFacts(facts: Pick<HostFacts, 'gpus'>): ResidencyGpu {
  const working = facts.gpus.filter((g) => g.driverWorking && g.vendor !== 'none');
  if (working.length === 0) return { present: false, integratedAmd: false, label: 'none' };
  const amd = working.find((g) => g.vendor === 'amd');
  return {
    present: true,
    integratedAmd: amd !== undefined && isIntegratedAmdGpu(amd),
    label: working.map((g) => `${g.vendor}${g.gfx ? `/${g.gfx}` : ''}`).join(', '),
  };
}

export interface CpuResidentFinding {
  model: string;
  sizeBytes: number;
  vramBytes: number;
  /** `vulkan-without-igpu`: the combination the managed bind file now prevents. `unknown`: measured, not explained. */
  cause: 'vulkan-without-igpu' | 'unknown';
  /** The measurement plus, when the environment explains it, the reason. One sentence. */
  why: string;
  /** What to run. Present when the cause has a known fix. */
  fix?: string;
}

/** Less than this share of a model's bytes in VRAM is "on the CPU", whatever the daemon calls it. */
export const CPU_RESIDENT_VRAM_FRACTION = 0.5;

export const formatGib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/**
 * Which resident models are on the CPU, and why, on a node with a GPU.
 *
 * Pure. A node whose GPU is unknown (a remote read) or absent yields nothing: the first is not
 * evidence, the second is not a problem. A model with `size_vram` below half its size is flagged —
 * zero is the case measured, and a partial offload that leaves most of the model in system memory
 * runs at the same speed for the same reason. The vulkan/iGPU reason is named only when every part
 * of it is in evidence: Vulkan forced, the iGPU key not `1`, and an integrated AMD part.
 */
export function judgeOllamaResidency(reading: Pick<OllamaResidencyReading, 'models' | 'env' | 'gpu'>): CpuResidentFinding[] {
  if (!reading.models || !reading.gpu?.present) return [];
  const findings: CpuResidentFinding[] = [];
  for (const m of reading.models) {
    if (m.size <= 0) continue;
    if (m.sizeVram / m.size >= CPU_RESIDENT_VRAM_FRACTION) continue;
    const measured = m.sizeVram === 0 ? `size_vram 0 of ${formatGib(m.size)}` : `size_vram ${formatGib(m.sizeVram)} of ${formatGib(m.size)}`;
    const vulkan = reading.env?.llmLibrary === 'vulkan';
    const igpu = reading.env?.igpuEnable;
    if (vulkan && igpu !== '1' && reading.gpu.integratedAmd) {
      const key = igpu === undefined ? 'OLLAMA_IGPU_ENABLE unset' : `OLLAMA_IGPU_ENABLE=${igpu}`;
      findings.push({
        model: m.name,
        sizeBytes: m.size,
        vramBytes: m.sizeVram,
        cause: 'vulkan-without-igpu',
        why: `${measured}: OLLAMA_LLM_LIBRARY=vulkan with ${key} — Ollama drops an integrated GPU unless OLLAMA_IGPU_ENABLE=1, so the model loaded on the CPU`,
        fix:
          igpu === '0'
            ? "re-run 'cihub fleet backends --backends ollama --ollama-igpu unset --execute' (or on) — the runtime file's --ollama-igpu off outranks the managed bind file's OLLAMA_IGPU_ENABLE=1"
            : "run 'cihub fleet backends --backends ollama --execute' — the managed bind file now carries OLLAMA_IGPU_ENABLE=1 beside OLLAMA_LLM_LIBRARY=vulkan on gfx1151",
      });
      continue;
    }
    findings.push({
      model: m.name,
      sizeBytes: m.size,
      vramBytes: m.sizeVram,
      cause: 'unknown',
      why: `${measured} on a node with a GPU (${reading.gpu.label}) — the daemon did not place it there; 'journalctl -u ollama' around the load says why`,
    });
  }
  return findings;
}

/** `resident: none` / `resident: qwen3-coder:30b (18.6 GiB, GPU)` — the inventory line under an ollama plan. */
export function describeResidency(reading: Pick<OllamaResidencyReading, 'models' | 'reason' | 'host'>): string {
  if (!reading.models) return `resident: unread — ${reading.reason ?? 'no reading'}`;
  if (reading.models.length === 0) return 'resident: none';
  const cells = reading.models.map((m) => {
    const where =
      m.size > 0 && m.sizeVram / m.size >= CPU_RESIDENT_VRAM_FRACTION
        ? 'GPU'
        : m.sizeVram === 0
          ? 'CPU'
          : `${Math.round((100 * m.sizeVram) / Math.max(m.size, 1))}% VRAM`;
    return `${m.name} (${formatGib(m.size)}, ${where})`;
  });
  return `resident: ${cells.join(', ')}`;
}

/** One warning line per CPU-resident model, for the plan and for the status footer. */
export function describeCpuResident(finding: CpuResidentFinding): string {
  return `${finding.model} resident on CPU — ${finding.why}${finding.fix ? `; ${finding.fix}` : ''}`;
}

/**
 * The status cell: every resident model by name, the ones on the CPU marked. A dash for nothing
 * loaded, `?` for a reading nobody could take — never a blank that looks like "nothing loaded".
 */
export function renderResidencyCell(
  reading: Pick<OllamaResidencyReading, 'models' | 'reason'>,
  findings: readonly CpuResidentFinding[],
): { text: string; tone: 'yellow' | 'dim' | undefined } {
  if (!reading.models) return { text: '?', tone: 'dim' };
  if (reading.models.length === 0) return { text: '—', tone: undefined };
  const onCpu = new Set(findings.map((f) => f.model));
  const text = reading.models.map((m) => (onCpu.has(m.name) ? `${m.name} ⚠ CPU` : m.name)).join(', ');
  return { text, tone: onCpu.size ? 'yellow' : undefined };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** Read residency on one node over SSH, at the bind it resolves for itself. */
export async function readOllamaResidencyOnNode(
  target: SshTarget,
  opts: { timeoutMs?: number } = {},
): Promise<Omit<OllamaResidencyReading, 'node' | 'source'>> {
  const res = await sshCapture(target, `bash <<'CIHUB_OLLAMA_PS_EOF'\n${ollamaResidencyScript()}\nCIHUB_OLLAMA_PS_EOF`, opts.timeoutMs ?? 20_000);
  if (res.out.includes(RESIDENCY_PROBE_MARKER)) return parseOllamaResidencyOutput(res.out);
  return { reason: `ssh ${classifySshFailure(res)}${res.err ? `: ${res.err.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 120)}` : ''}` };
}

async function fetchRemotePs(ip: string, timeoutMs: number): Promise<OllamaLoadedModel[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${OLLAMA_API_PORT}/api/ps`, { signal: controller.signal });
    if (!res.ok) return null;
    return parseOllamaPsBody(await res.text()) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ResidencyProbeInput {
  node: FleetNode;
  /** What the status probe already learned about SSH, so a denied node is not dialled twice. */
  sshOk?: boolean;
  sshFailure?: SshFailure;
}

/**
 * Read one node's residency for `status`.
 *
 * On the node first, over SSH — the only way to reach a daemon bound to loopback or its tailnet
 * address alone, and the only way to read the environment and the GPU beside the models. From here
 * second, on `:11434`, only for a node SSH was not attempted on: a node whose own probe ran and found
 * nothing at its bind has nothing more to say from here, and a remote reading carries no GPU or
 * environment, so it can list models but never flag one.
 */
export async function readOllamaResidency(
  input: ResidencyProbeInput,
  opts: { user?: string; timeoutMs?: number } = {},
): Promise<OllamaResidencyReading> {
  const { node } = input;
  const httpTimeout = opts.timeoutMs ?? 4_000;
  if (!node.local && input.sshOk !== false) {
    const onNode = await readOllamaResidencyOnNode({ host: node.ip, user: node.user ?? opts.user }, { timeoutMs: Math.max(httpTimeout, 15_000) });
    return { node: node.name, ...onNode, source: 'node' };
  }
  const remote = await fetchRemotePs(node.ip, httpTimeout);
  if (remote) return { node: node.name, models: remote, host: `${node.ip}:${OLLAMA_API_PORT}`, source: 'remote' };
  return {
    node: node.name,
    reason: `${node.local ? 'local node' : `ssh ${input.sshFailure ?? 'unavailable'}`}; :${OLLAMA_API_PORT}/api/ps did not answer from here`,
  };
}

/** Read every node, bounded. Order of the result matches the input. */
export async function readOllamaResidencies(
  inputs: readonly ResidencyProbeInput[],
  opts: { user?: string; timeoutMs?: number; concurrency?: number } = {},
): Promise<OllamaResidencyReading[]> {
  const out: OllamaResidencyReading[] = new Array(inputs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= inputs.length) return;
      out[i] = await readOllamaResidency(inputs[i] as ResidencyProbeInput, opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 4), Math.max(inputs.length, 1)) }, worker));
  return out;
}
