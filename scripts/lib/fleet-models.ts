/**
 * Which models each fleet node should hold, and where that answer came from.
 *
 * `cihub fleet update --models a,b` applied one flat list to every node. Measured on this fleet
 * (2026-09-10): model sets had drifted to anywhere from 2 to 23 per node, across hardware that has
 * nothing in common — gfx1151 Strix Halo boxes with ~120 GB unified memory, a gfx1100 RX 7900 XTX
 * beside 498 GB of RAM, an RTX 3080, an 8 GB RTX A1000, a laptop 4080, a gfx1036. One node had no
 * embedding model at all, and CI-Server refuses to boot without a 768-dim embedder.
 *
 * The Hub on every node already computes a hardware-fitted top-N from its own `HardwareProfile`
 * (`ModelRegistryService.getRecommendedModelsForHardware`, served by
 * `GET /api/inference/onboarding-profile`). This file asks each node's Hub for that answer instead
 * of inventing a second recommender here, and says which of three places a node's list came from:
 *
 *   · `hub-recommended` — the node's own Hub answered. The list is the Hub's Ollama picks.
 *   · `explicit`        — the operator named the models on the command line.
 *   · `floor-only`      — the Hub could not be asked (unreachable, unclaimed, key rejected), so the
 *                          node gets only the platform floor and the reason is printed. Deliberately
 *                          NOT a locally computed guess: a profile assembled here from SSH-read facts
 *                          would differ from the Hub's own, and two lists for one box is the drift
 *                          this command exists to end.
 *
 * Whatever the provenance, {@link PLATFORM_REQUIRED_MODELS} is appended. That is a requirement, not a
 * recommendation, and it never depends on hardware.
 *
 * AUTH, settled from the source rather than guessed (2026-09-10): the route is behind `AuthGuard`,
 * which only checks `req.user`; `AuthMiddleware` (mounted on `*all`) installs the first operator as
 * `req.user` when `Authorization: Bearer <ciHubApiKey>` matches the device key in constant time.
 * So a device key IS accepted — a browser session is not required. Verified with one read-only GET
 * against a claimed node: HTTP 200. Two refusals look alike and must stay distinct: an unclaimed Hub
 * answers 409 `AUTH_ERROR_HUB_NOT_CLAIMED` (fix: `cihub claim`), a wrong or missing key answers 401
 * `SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN` (fix: the key). Reading both as "bad key" cost a week once.
 *
 * The key never leaves the node: the fetch runs ON the node over SSH against its own loopback, and
 * the script prints only the HTTP status and the body. Nothing here echoes the key.
 */

/** Models every node must hold regardless of hardware. CI-Server throws at boot without a 768-dim embedder. */
export const PLATFORM_REQUIRED_MODELS: readonly string[] = ['nomic-embed-text'];

/** The `--models` value that asks each node's Hub instead of naming models. */
export const RECOMMENDED_MODELS_KEYWORD = 'recommended';

export type ModelListProvenance = 'hub-recommended' | 'explicit' | 'floor-only';

/** One model on one node's plan. */
export interface PlannedModel {
  /** The Ollama tag to pull, e.g. `qwen3.5:9b`. */
  tag: string;
  /** Catalog disk estimate, when the Hub supplied one. */
  diskMb?: number;
  /** True/false when the Hub's live tag list settled it; undefined when nobody could say. */
  installed?: boolean;
  /** True for the platform floor, so the report can show it was appended rather than recommended. */
  required?: boolean;
}

export interface NodeModelPlan {
  node: string;
  provenance: ModelListProvenance;
  models: PlannedModel[];
  /** One line on what the Hub reported about the machine, for a dry run that shows its working. */
  hardware?: string;
  /** Why a `floor-only` plan is floor-only. Always set for that provenance, never for the others. */
  reason?: string;
  /** What the operator should do about a `floor-only` plan. */
  fix?: string;
}

// ─── Asking a node's Hub ───────────────────────────────────────────────────────

/**
 * Shell that runs on the node: find the device key, ask the local Hub, report status and body.
 *
 * The key is read inside the `ci-hub` container first (`/data/state/settings.json`, the one path
 * that holds regardless of where the host keeps its data dir), then from the host data dir the
 * fleet CLI was told about. It is held in a shell variable, sent as a header, and unset — never
 * echoed. When no key is found the request is still made without one, because the answer tells
 * the operator whether the Hub is up at all, which is a different problem from a missing key.
 */
export function hubRecommendationScript(dataDir = '/var/lib/companion-hub'): string {
  const hostSettings = `${dataDir.replace(/'/g, "'\\''")}/state/settings.json`;
  return [
    'set +e',
    'key=""',
    "if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx ci-hub; then",
    // `node -e` rather than grep/sed: a JSON value can legally carry escapes a regex would truncate.
    `  key="$(docker exec ci-hub node -e 'try{const s=require("/data/state/settings.json");process.stdout.write(String(s.ciHubApiKey||""))}catch{}' 2>/dev/null)"`,
    'fi',
    `if [ -z "$key" ] && [ -r '${hostSettings}' ]; then`,
    `  key="$(sed -n 's/.*"ciHubApiKey"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' '${hostSettings}' | head -1)"`,
    'fi',
    'if [ -n "$key" ]; then echo "device-key=present"; else echo "device-key=missing"; fi',
    'body="$(mktemp)"',
    // `-w '%{http_code}'` prints `000` itself when the connection fails, so there is no `|| echo 000`
    // here: with one, a refused connection printed `000000` and matched nothing. Only an empty
    // string (curl missing entirely) needs the fallback.
    'if [ -n "$key" ]; then',
    '  code="$(curl -s -o "$body" -w \'%{http_code}\' --max-time 30 -H "Authorization: Bearer $key" http://127.0.0.1:5002/api/inference/onboarding-profile 2>/dev/null)"',
    'else',
    '  code="$(curl -s -o "$body" -w \'%{http_code}\' --max-time 30 http://127.0.0.1:5002/api/inference/onboarding-profile 2>/dev/null)"',
    'fi',
    'unset key',
    '[ -n "$code" ] || code=000',
    'echo "onboarding-http=$code"',
    'echo "onboarding-body-begin"',
    'cat "$body" 2>/dev/null',
    'echo',
    'echo "onboarding-body-end"',
    'rm -f "$body"',
    'true',
  ].join('\n');
}

/** The subset of the onboarding-profile payload this file reads. Everything else is ignored. */
interface OnboardingProfilePayload {
  tier?: string;
  hardware?: {
    gpu?: { vendor?: string; model?: string; vramMb?: number; unifiedMemory?: boolean };
    ram?: { totalMb?: number };
  };
  recommendedModels?: CatalogRow[];
  availableModels?: CatalogRow[];
  installedCatalogIds?: string[];
  backends?: { recommended?: string };
}

interface CatalogRow {
  id?: string;
  backend?: string;
  backendModelId?: string;
  modality?: string;
  requirements?: { diskMb?: number };
}

/** What the Hub knows about one Ollama tag, independent of whether it recommended it. */
export interface KnownModel {
  diskMb?: number;
  installed: boolean;
}

export type HubRecommendationFailureKind =
  /** SSH itself failed; nothing on the node was reached. */
  | 'ssh-failed'
  /** Nothing answered on the node's loopback Hub port. */
  | 'hub-unreachable'
  /** The Hub is up, but no device key could be found on the node. */
  | 'no-device-key'
  /** 409 AUTH_ERROR_HUB_NOT_CLAIMED — the key is valid; the Hub has no operator to act as. */
  | 'hub-unclaimed'
  /** 401 SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN — the Hub did not accept the key it was shown. */
  | 'unauthorized'
  /** Any other non-2xx. */
  | 'http-error'
  /** 200, but not the payload this file knows how to read. */
  | 'bad-response';

export type HubRecommendation =
  | {
      kind: 'ok';
      /** The Hub's Ollama picks, best first, with the floor's presence resolved where the Hub knew it. */
      models: PlannedModel[];
      hardware: string;
      /**
       * Every Ollama row the Hub knows (recommended or merely available), keyed by normalised tag,
       * with presence from the live tag list and the catalog disk estimate. Lets the floor and an
       * explicit tag be priced and presence-checked without a second round trip.
       */
      catalog: Map<string, KnownModel>;
    }
  | { kind: HubRecommendationFailureKind; detail?: string; httpStatus?: number };

/** `a:latest` and `a` are the same Ollama tag. Compare on the stripped form everywhere. */
export function normaliseModelTag(tag: string): string {
  return tag.trim().replace(/:latest$/, '');
}

function errorCodeIn(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown; code?: unknown };
    for (const candidate of [parsed.message, parsed.code, parsed.error]) {
      if (typeof candidate === 'string' && candidate) return candidate;
    }
  } catch {
    // Not JSON — a Traefik or proxy error page. The status code still tells the story.
  }
  return undefined;
}

function describeHardware(payload: OnboardingProfilePayload): string {
  const gpu = payload.hardware?.gpu;
  const ram = payload.hardware?.ram?.totalMb;
  const gpuText =
    gpu?.vendor && gpu.vendor !== 'none'
      ? `${gpu.vendor}${gpu.model ? ` ${gpu.model}` : ''}${gpu.unifiedMemory ? ' (unified)' : gpu.vramMb ? ` ${Math.round(gpu.vramMb / 1024)} GB` : ''}`
      : 'no gpu';
  const ramText = ram ? `${Math.round(ram / 1024)} GB ram` : 'ram ?';
  return `tier ${payload.tier ?? '?'} · ${gpuText} · ${ramText} · backend ${payload.backends?.recommended ?? '?'}`;
}

/**
 * Turn the node's script output into a recommendation or a named failure.
 *
 * Status before body: a 409 and a 401 are the two findings this fleet has already confused, and they
 * need opposite responses, so the HTTP status decides and the body's error code is only detail.
 */
export function parseHubRecommendationOutput(out: string): HubRecommendation {
  // Three digits, tolerating trailing noise: an older script printed `000000` on a refused
  // connection, and a status line that exists must never be read as "no status".
  const httpMatch = /^onboarding-http=(\d{3})\d*\s*$/m.exec(out);
  if (!httpMatch) return { kind: 'hub-unreachable', detail: 'the probe produced no HTTP status' };
  const status = Number(httpMatch[1]);
  const keyPresent = /^device-key=present$/m.test(out);
  const begin = out.indexOf('onboarding-body-begin\n');
  const end = out.lastIndexOf('\nonboarding-body-end');
  const body = begin >= 0 && end > begin ? out.slice(begin + 'onboarding-body-begin\n'.length, end).trim() : '';

  if (status === 0) return { kind: 'hub-unreachable', detail: 'nothing answered on 127.0.0.1:5002' };
  if (!keyPresent) return { kind: 'no-device-key', httpStatus: status, detail: `the Hub answered HTTP ${status} to an unauthenticated probe` };
  if (status === 409) return { kind: 'hub-unclaimed', httpStatus: status, detail: errorCodeIn(body) };
  if (status === 401) return { kind: 'unauthorized', httpStatus: status, detail: errorCodeIn(body) };
  if (status < 200 || status >= 300) return { kind: 'http-error', httpStatus: status, detail: errorCodeIn(body) ?? body.slice(0, 120) };

  let payload: OnboardingProfilePayload;
  try {
    payload = JSON.parse(body) as OnboardingProfilePayload;
  } catch {
    return { kind: 'bad-response', httpStatus: status, detail: 'HTTP 200 with a body that is not JSON' };
  }
  if (!Array.isArray(payload.recommendedModels)) {
    return { kind: 'bad-response', httpStatus: status, detail: 'HTTP 200 without a recommendedModels array' };
  }

  const installedIds = new Set(payload.installedCatalogIds ?? []);
  const catalog = new Map<string, KnownModel>();
  for (const row of [...payload.recommendedModels, ...(payload.availableModels ?? [])]) {
    if (row.backend !== 'ollama' || !row.backendModelId) continue;
    const key = normaliseModelTag(row.backendModelId);
    if (catalog.has(key)) continue;
    catalog.set(key, {
      diskMb: typeof row.requirements?.diskMb === 'number' ? row.requirements.diskMb : undefined,
      installed: row.id ? installedIds.has(row.id) : false,
    });
  }

  // Only what `ollama pull` can act on. The Hub's list spans every backend it knows (vLLM, Lemonade,
  // MTPLX…); those are installed by other means and would fail here as unknown Ollama tags.
  const models: PlannedModel[] = [];
  const seen = new Set<string>();
  for (const row of payload.recommendedModels) {
    if (row.backend !== 'ollama' || !row.backendModelId) continue;
    const key = normaliseModelTag(row.backendModelId);
    if (seen.has(key)) continue;
    seen.add(key);
    const known = catalog.get(key);
    models.push({ tag: row.backendModelId, diskMb: known?.diskMb, installed: row.id ? known?.installed : undefined });
  }

  return { kind: 'ok', models, hardware: describeHardware(payload), catalog };
}

/** Operator-facing wording for each way the Hub could not be asked, with what to do about it. */
export function describeHubRecommendationFailure(failure: Exclude<HubRecommendation, { kind: 'ok' }>): { reason: string; fix: string } {
  const detail = failure.detail ? ` (${failure.detail})` : '';
  switch (failure.kind) {
    case 'ssh-failed':
      return { reason: `SSH to the node failed${detail}`, fix: "check 'cihub fleet scan' for this node's SSH verdict" };
    case 'hub-unreachable':
      return { reason: `the node's Hub did not answer${detail}`, fix: "is the Hub running there? 'cihub status' on the node" };
    case 'no-device-key':
      return {
        reason: `no device key found on the node${detail}`,
        fix: "the Hub is up but unregistered, or its data dir is elsewhere — 'cihub register', or pass --data-dir",
      };
    case 'hub-unclaimed':
      return {
        reason: `the Hub is registered but has no operator — HTTP 409${detail}`,
        fix: "'cihub claim --email <addr>' on the node; the device key itself is fine",
      };
    case 'unauthorized':
      return {
        reason: `the Hub rejected the device key — HTTP 401${detail}`,
        fix: "the key in state/settings.json is not the one this Hub holds; re-run 'cihub register'",
      };
    case 'http-error':
      return { reason: `the Hub answered HTTP ${failure.httpStatus ?? '?'}${detail}`, fix: 'read the Hub logs on the node' };
    case 'bad-response':
      return { reason: `the Hub answered but not with a profile${detail}`, fix: 'the node may run a Hub older than this CLI; update it with --hub' };
  }
}

// ─── Building a node's plan ────────────────────────────────────────────────────

/**
 * Append the platform floor, deduplicating on the normalised tag so `nomic-embed-text:latest` in an
 * explicit list does not produce a second pull of the same model.
 */
export function withPlatformFloor(models: readonly PlannedModel[], catalog?: ReadonlyMap<string, KnownModel>): PlannedModel[] {
  const out: PlannedModel[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const key = normaliseModelTag(model.tag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(PLATFORM_REQUIRED_MODELS.some((required) => normaliseModelTag(required) === key) ? { ...model, required: true } : model);
  }
  for (const required of PLATFORM_REQUIRED_MODELS) {
    const key = normaliseModelTag(required);
    if (seen.has(key)) continue;
    seen.add(key);
    // Presence is only knowable when a Hub answered; without one it stays undefined and the floor
    // is pulled, which on a present model is a manifest check and nothing more.
    const known = catalog?.get(key);
    out.push({ tag: required, required: true, installed: catalog ? (known?.installed ?? false) : undefined, diskMb: known?.diskMb });
  }
  return out;
}

export type ModelRequest = { kind: 'explicit'; models: readonly string[] } | { kind: 'recommended' };

/**
 * Decide one node's list and its provenance.
 *
 * `recommendation` is only consulted for a `recommended` request: an explicit list is what the
 * operator said, and a Hub that disagrees does not get a vote. A failed recommendation never yields
 * an empty plan — the floor still goes on, and the reason goes in the report next to it.
 */
export function planNodeModels(node: string, request: ModelRequest, recommendation?: HubRecommendation): NodeModelPlan {
  if (request.kind === 'explicit') {
    const catalog = recommendation?.kind === 'ok' ? recommendation.catalog : undefined;
    return {
      node,
      provenance: 'explicit',
      models: withPlatformFloor(
        request.models.map((tag) => {
          const known = catalog?.get(normaliseModelTag(tag));
          return { tag, installed: catalog ? (known?.installed ?? false) : undefined, diskMb: known?.diskMb };
        }),
        catalog,
      ),
    };
  }
  if (recommendation?.kind === 'ok') {
    return {
      node,
      provenance: 'hub-recommended',
      hardware: recommendation.hardware,
      models: withPlatformFloor(recommendation.models, recommendation.catalog),
    };
  }
  const { reason, fix } = describeHubRecommendationFailure(recommendation ?? { kind: 'hub-unreachable', detail: 'no recommendation was fetched' });
  return { node, provenance: 'floor-only', reason, fix, models: withPlatformFloor([]) };
}

/** Bytes a plan would fetch, counting only models the Hub priced and did not report present. */
export function estimatedDownloadMb(plan: NodeModelPlan): number | undefined {
  let total = 0;
  let priced = false;
  for (const model of plan.models) {
    if (model.installed === true || model.diskMb === undefined) continue;
    total += model.diskMb;
    priced = true;
  }
  return priced ? total : undefined;
}

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// ─── Reporting a pull ──────────────────────────────────────────────────────────

export type PullOutcome = 'pulled' | 'already-present' | 'failed';

export interface ModelPullResult {
  tag: string;
  outcome: PullOutcome;
  detail?: string;
  ms?: number;
}

/** Tally one node's results for the summary line and the exit code. */
export function summarisePulls(results: readonly ModelPullResult[]): { pulled: number; present: number; failed: number } {
  let pulled = 0;
  let present = 0;
  let failed = 0;
  for (const result of results) {
    if (result.outcome === 'pulled') pulled += 1;
    else if (result.outcome === 'already-present') present += 1;
    else failed += 1;
  }
  return { pulled, present, failed };
}
