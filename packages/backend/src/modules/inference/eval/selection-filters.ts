/**
 * WHAT AN EVAL RUN WILL ACTUALLY COVER — pure predicates over plain data, no I/O.
 *
 * There is exactly ONE filter chain, and it lives here. The rule it encodes is not "filtering", it is
 * that the count shown before a run starts must be computed by the code that builds the run. The
 * arrangement this replaced had a picker carrying its own approximation of the chain and a comment
 * saying the dispatcher was authoritative — which is another way of saying the number on screen was
 * allowed to be wrong. A selector whose count disagrees with the run it starts is worse than no
 * selector, so there is no second opinion to drift: `catalogDrop` is the chain, everything else here
 * reads it.
 *
 * The other rule, running through every function below: a candidate that cannot run is a SKIP that
 * names both sides of the mismatch, never a silent omission and never a synthetic pass. `archSkipNote`
 * and `modelSkipNote` exist to produce that sentence, and `catalogDrop` returns one for every drop.
 *
 * SEVERED FROM ITS ORIGIN: the version this was ported from indexed everything by machine name off a
 * static roster. There is no roster here. Every place a name appeared now takes an opaque `endpoint`
 * label supplied by the caller — a host:port, a discovery id, whatever the caller can explain to an
 * operator — and this module never interprets it.
 */

import type { InferenceBackendType } from '@ci-hub/common/types';
import { isMlxBuild } from './model-select';

// ─── Architecture vocabulary ──────────────────────────────────────────────────

/** The architectures an eval target can report. `unknown` is a HOST state, never an app's declaration. */
export type KnownArch = 'amd64' | 'arm64';
export type HostArch = KnownArch | 'unknown';

export const KNOWN_ARCHES: readonly KnownArch[] = ['amd64', 'arm64'];

/** `off` disables the arch gate entirely, for a caller that has already resolved compatibility itself. */
export type ArchGateMode = 'on' | 'off';

/**
 * Map whatever a machine or a manifest calls itself onto the two names used here.
 *
 * `uname -m` says `aarch64` on Linux/arm and `arm64` on macOS; Node's `os.arch()` says `x64`. Anything
 * unrecognised stays `unknown` — never defaulted to amd64, because a wrong default is exactly how an
 * incompatible image gets dispatched and then blamed on the app.
 */
export function normalizeArch(raw: unknown): HostArch {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (v === 'arm64' || v === 'aarch64' || v === 'armv8' || v === 'armv8l' || v === 'arm64/v8') return 'arm64';
  if (v === 'amd64' || v === 'x86_64' || v === 'x64' || v === 'x86-64') return 'amd64';
  return 'unknown';
}

/**
 * May this app be dispatched to a host of this architecture?
 *
 *   · app declares nothing  → yes, there is no declaration to violate
 *   · host arch known       → only if the app declares it
 *   · host arch UNKNOWN     → only apps that declare EVERY known arch
 *
 * That last rule is the point of the `unknown` state existing at all: a host whose `uname -m` could
 * not be read is not assumed to be amd64 (which would dispatch every amd64-only app to a machine that
 * may be arm), and it is not excluded either — it still gets the apps that run everywhere.
 *
 * NOT a replacement for the install-time gate in AppLifecycleService, which answers a different
 * question — "may THIS host install this app", with emulation as a fallback. This one answers "which
 * of many targets is this app even a candidate for", which is why it needs the `unknown` state and
 * that one does not.
 */
export function archCompatible(architectures: readonly string[] | null | undefined, hostArch: HostArch, mode: ArchGateMode = 'on'): boolean {
  if (mode === 'off') return true;
  const declared = (architectures ?? []).map(normalizeArch);
  if (declared.length === 0) return true;
  if (hostArch === 'unknown') return KNOWN_ARCHES.every((a) => declared.includes(a));
  return declared.includes(hostArch);
}

/**
 * The whole-selection form: is there ANY selected target this app could run on?
 *
 * An empty target set is `false` — nothing to dispatch to is not the same as "runs anywhere", and the
 * caller has to distinguish "no target passed preflight" from "no target offers this architecture".
 */
export function runnableOnAny(
  architectures: readonly string[] | null | undefined,
  hostArches: readonly HostArch[],
  mode: ArchGateMode = 'on',
): boolean {
  if (hostArches.length === 0) return false;
  return hostArches.some((a) => archCompatible(architectures, a, mode));
}

/** Skip sentence for a row the arch gate will drop. Names BOTH sides — that is the whole value. */
export function archSkipNote(architectures: readonly string[] | null | undefined, hostArches: readonly HostArch[]): string {
  const declared = (architectures ?? []).join('+') || 'nothing';
  const offered = hostArches.length ? [...new Set(hostArches)].join(', ') : 'no target';
  return `declares ${declared}; selected targets offer ${offered} — this app becomes a skip row with a reason, never a pass and never a fail`;
}

/** The three shapes a catalog actually contains, plus the manifests that declare nothing. */
export type AppArchClass = 'universal' | 'amd64-only' | 'arm64-only' | 'undeclared';

/** `any` widens to everything; the rest are the classes above plus the two bare arch names. */
export type ArchFilter = 'any' | KnownArch | AppArchClass;

/**
 * A catalog row, reduced to the fields the chain reads.
 *
 * Deliberately structural and loose: an eval run is pointed at whatever catalog the operator has, and
 * a filter that only accepts one repo's DTO is a filter that cannot be reused. Callers whose rows
 * spell the field `supported_architectures` map it on the way in.
 */
export interface EvalCandidateApp {
  id: string;
  name?: string;
  categories?: readonly string[];
  priority?: string;
  architectures?: readonly string[];
  /** `false` means the upstream manifest has delisted it; absent means nothing was claimed. */
  available?: boolean;
}

export function appArchClass(app: Pick<EvalCandidateApp, 'architectures'> | null | undefined): AppArchClass {
  const a = app?.architectures ?? [];
  if (a.length === 0) return 'undeclared';
  const amd = a.includes('amd64');
  const arm = a.includes('arm64');
  if (amd && arm) return 'universal';
  return amd ? 'amd64-only' : 'arm64-only';
}

export function matchesArchFilter(app: Pick<EvalCandidateApp, 'architectures'> | null | undefined, filter: ArchFilter = 'any'): boolean {
  if (!filter || filter === 'any') return true;
  const a = app?.architectures ?? [];
  if (filter === 'amd64') return a.includes('amd64');
  if (filter === 'arm64') return a.includes('arm64');
  return appArchClass(app) === filter;
}

// ─── App search + the one filter chain ────────────────────────────────────────

/**
 * Free-text match over id, display name and categories.
 *
 * Whitespace-separated terms are ANDed: typing more always narrows, never widens — a search box that
 * widens as you type is one an operator stops trusting.
 */
export function matchesQuery(
  app: Pick<EvalCandidateApp, 'id' | 'name' | 'categories'> | null | undefined,
  query: string | null | undefined,
): boolean {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!q) return true;
  const hay = `${app?.id ?? ''} ${app?.name ?? ''} ${(app?.categories ?? []).join(' ')}`.toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export interface CatalogFilters {
  arch?: ArchFilter;
  categories?: readonly string[];
  priorities?: readonly string[];
  /** Explicit inclusion. Non-empty means "only these ids". */
  ids?: readonly string[];
  /** Explicit exclusion, and it wins over `ids`. */
  excludeIds?: readonly string[];
  availableOnly?: boolean;
  /** A cap on the SORTED survivors, so it is applied by the caller and ignored here. */
  limit?: number | null;
  query?: string;
}

/**
 * Why this app is NOT in the run, or null when it survives every filter.
 *
 * THE filter chain. A caller walks its catalog through this and turns each returned string into an
 * accounted exclusion. Order matters only for which reason a doubly-excluded app is reported under —
 * exclusion beats inclusion, so an id in both lists is excluded and says so.
 */
export function catalogDrop(app: EvalCandidateApp, filters: CatalogFilters = {}): string | null {
  const ex = filters.excludeIds ?? [];
  if (ex.length && ex.includes(app.id)) return `excludeIds lists ${app.id}`;
  const ids = filters.ids ?? [];
  if (ids.length && !ids.includes(app.id)) return 'not in the explicit ids list';
  if (filters.availableOnly && app.available === false) return 'availableOnly: manifest says available:false (delisted upstream)';
  const cats = filters.categories ?? [];
  if (cats.length && !(app.categories ?? []).some((c) => cats.includes(c))) return `categories=${cats.join(',')}: app declares none of them`;
  const prios = filters.priorities ?? [];
  if (prios.length && (app.priority === undefined || !prios.includes(app.priority))) {
    return `priorities=${prios.join(',')}: app is ${app.priority ?? 'unset'}`;
  }
  if (!matchesArchFilter(app, filters.arch ?? 'any')) return `arch=${filters.arch}: app declares ${(app.architectures ?? []).join('+') || 'nothing'}`;
  if (!matchesQuery(app, filters.query)) return `query="${String(filters.query).trim()}": no match in id, name or categories`;
  return null;
}

/** Survivors of the chain, in the catalog's own order. Sorting and `limit` stay with the caller. */
export function filterApps<T extends EvalCandidateApp>(apps: readonly T[], filters: CatalogFilters = {}): T[] {
  return apps.filter((a) => catalogDrop(a, filters) === null);
}

/** A copy of a filter set with the explicit id lists dropped — the "what is there to pick from" view. */
export function browseFilters(filters: CatalogFilters = {}): Required<CatalogFilters> {
  return {
    arch: filters.arch ?? 'any',
    categories: filters.categories ?? [],
    priorities: filters.priorities ?? [],
    ids: [],
    excludeIds: [],
    availableOnly: filters.availableOnly === true,
    limit: null,
    query: filters.query ?? '',
  };
}

// ─── Prompt / backend selection ───────────────────────────────────────────────

/** A prompt-bank entry, reduced to the field this split reads. */
export interface BackendTargeted {
  backends?: readonly InferenceBackendType[];
}

/**
 * Split a prompt bank into the entries at least one SELECTED backend can serve and the entries none
 * can.
 *
 * A prompt whose backends are all deselected produces no work at all, so listing it beside the ones
 * that will run is a promise the run does not keep. An empty or absent backend selection means every
 * backend in INFERENCE_BACKEND_TYPES, so nothing is hidden — the caller does not have to enumerate
 * them to mean "all".
 */
export function promptSplit<T extends BackendTargeted>(
  bank: readonly T[],
  backends: readonly InferenceBackendType[] | null | undefined,
): { shown: T[]; hidden: T[] } {
  const sel = backends?.length ? backends : null;
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const p of bank) {
    const reachable = !sel || (p.backends ?? []).some((b) => sel.includes(b));
    (reachable ? shown : hidden).push(p);
  }
  return { shown, hidden };
}

// ─── Model selection ──────────────────────────────────────────────────────────

/** What one endpoint reported holding. `models` are the ids the endpoint itself listed, verbatim. */
export interface EndpointInventory {
  backend: string;
  models: readonly string[];
}

/**
 * What a probe found, keyed by endpoint label.
 *
 * The key is an opaque caller-supplied label — a host:port, a discovery id — and nothing here parses
 * it. One label may front several backends, which is why the value is a list.
 */
export type ProbedInventory = Record<string, readonly EndpointInventory[]>;

export interface ModelPool {
  model: string;
  mlx: boolean;
  /** Endpoint labels holding this model, in the order the inventory listed them. */
  endpoints: string[];
  backends: string[];
}

/**
 * Every distinct model a probe found, and where it lives. Sorted by name so two runs over the same
 * inventory produce the same list — an unstable order turns a diff of two runs into noise.
 */
export function modelPools(inventory: ProbedInventory | null | undefined): ModelPool[] {
  const byModel = new Map<string, ModelPool>();
  for (const [endpoint, endpoints] of Object.entries(inventory ?? {})) {
    for (const ep of endpoints ?? []) {
      for (const m of ep.models ?? []) {
        const name = String(m);
        if (!name) continue;
        let entry = byModel.get(name);
        if (!entry) {
          entry = { model: name, mlx: isMlxBuild(name), endpoints: [], backends: [] };
          byModel.set(name, entry);
        }
        if (!entry.endpoints.includes(endpoint)) entry.endpoints.push(endpoint);
        if (ep.backend && !entry.backends.includes(ep.backend)) entry.backends.push(ep.backend);
      }
    }
  }
  return [...byModel.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

/**
 * Narrow one endpoint's resident models to the operator's picks.
 *
 * An empty selection means "whatever this endpoint has". Matching is EXACT: the ids come from the
 * inventory the endpoint itself reported, and `qwen3:8b` and `qwen3:8b-mlx` are two different models
 * whose difference is the entire point of being able to pick one.
 */
export function filterModels(models: readonly string[] | null | undefined, selected: readonly string[] | null | undefined): string[] {
  if (!selected || selected.length === 0) return [...(models ?? [])];
  return (models ?? []).filter((m) => selected.includes(m));
}

/**
 * The skip sentence for an endpoint that has models but none the operator selected.
 *
 * Distinct from "no resident model at all", because the two call for opposite responses: one is a bare
 * endpoint, the other is a selection that does not match this endpoint's inventory. Both are skips
 * with a reason — nothing here ever pulls a model to make a case runnable.
 */
export function modelSkipNote(endpoint: string, backend: string, role: string, selected: readonly string[], available: readonly string[]): string {
  const have = available.slice(0, 4).join(', ') || 'none';
  return `none of the ${selected.length} selected model(s) is resident on ${endpoint}/${backend} for the ${role} role (has: ${have}) — skipped rather than pulling one`;
}

/**
 * Split requested model names into those the last probe actually saw and those it did not.
 *
 * The `unseen` half is a WARNING, never a rejection: unlike a prompt id, a model name has no fixed
 * vocabulary — the inventory can be empty (nothing probed yet) or stale (an endpoint pulled a model
 * since), and refusing the run would be refusing on the strength of a cache. They are reported
 * instead, and the run turns them into skip rows via `modelSkipNote` if they really are absent.
 */
export function partitionModels(
  requested: readonly string[] | null | undefined,
  inventory: ProbedInventory | null | undefined,
): { known: string[]; unseen: string[] } {
  const have = new Set(modelPools(inventory).map((p) => p.model));
  const known: string[] = [];
  const unseen: string[] = [];
  for (const m of requested ?? []) (have.has(m) ? known : unseen).push(m);
  return { known, unseen };
}
