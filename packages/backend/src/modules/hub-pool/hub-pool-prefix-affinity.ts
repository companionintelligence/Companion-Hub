import { createHash } from 'node:crypto';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { LOCAL_CANDIDATE_KEY } from './hub-pool-load.service';
import type { PoolCandidate } from './hub-pool.types';

// ── Prefix affinity ─────────────────────────────────────────────────────────
//
// Prefill dominates an agent turn on this fleet, and prefill is what a KV-prefix cache saves. Measured
// on core-2 through the pool proxy, 2026-09-20: OpenClaw's first turn was 44,340 prompt tokens, 258
// output, 100.8 s wall, of which Ollama's own journal put `prompt processing` at 67.34 s (608 tok/s).
// The agent's second model call in the same turn — 44,630 tokens, the same prefix — got only a
// partial cache hit (`cached n_tokens = 15958`, 28,672 tokens re-prefilled in 63 s): the four Ollama
// slots (`OLLAMA_NUM_PARALLEL=4`, fleet-wide since that day) are shared with other traffic, and the
// pool had no notion of which node, or which engine on it, held a session's prefix. The ranker
// scores queue depth, pressure and tier, all of which read the same for a node holding the prefix
// and a node that would prefill it cold.
//
// So the pool remembers. Every request on a judged route gets a key — the app's own
// `X-Hub-Pool-Session` header when it sends one, else a digest of the prompt's head: the system
// prompt and the first turn after it, every byte of both — and the node and engine that last served
// that key are moved to the front of the ranked list while their queue is shorter than
// `poolPrefixAffinityMaxInFlight`. Past that, waiting behind the queue costs more than the prefill
// it would save, and the ranker's order stands.
//
// The key has to name ONE session. An earlier build digested only the first 4 KB of the head, and
// an agent whose system prompt alone filled that gave every one of its sessions the same key, so the
// table remembered the node that last served ANY of them. Measured on core-2, 2026-09-21, with six
// concurrent sessions behind one 25k-token system prefix: every session's first turn logged as a
// `hit` on `local` though none had been served, and once slot awareness moved two of them to
// core-1 the shared entry flipped and the sessions still local were sent to core-1 cold — 14–42 s to
// a first byte where the warm node gave ~1 s. Herding is worse than no affinity, so the window is
// gone: one SHA-256 over the head in full, on bytes the proxy is about to serialise anyway.
//
// A preference, never a rule, with the same three properties as a pin: it reorders a finished list,
// so it cannot resurrect an excluded node; a key nothing is remembered for changes nothing; and every
// other candidate stays behind in ranked order, so failover is untouched. It is applied BEFORE the
// ceiling and throughput splits and the pin, so a ceiling (an operator's statement about a node), a
// throughput demotion (evidence the node is slow cold — which is exactly when its cache matters least
// to the ranker and most to the session, a trade left unmade on purpose) and a pin (an operator's
// preference) each still win over it.

/**
 * Request header an app may send to name its session. Any opaque string it likes — a chat id, an
 * agent run id — as long as it is the same on every call of one session. Preferred over the hashed
 * key because the app knows where a session begins and ends and the proxy can only guess.
 */
export const POOL_SESSION_HEADER = 'X-Hub-Pool-Session';
/** Response header carrying {@link PrefixAffinityOutcome}, on a served response and on the all-candidates-failed 502 alike. */
export const POOL_AFFINITY_HEADER = 'X-Hub-Pool-Affinity';

/**
 * How long a prefix's node is remembered. Ten minutes: an engine's prefix cache lives in a slot's
 * KV memory, which survives while the model stays loaded (`OLLAMA_KEEP_ALIVE`, 24 h on the fleet)
 * and no other prefix has claimed the slot. With four slots and shared traffic, whether a prefix is
 * still resident after ten idle minutes is a guess, and a stale entry costs a request the ranker's
 * first choice. Env-overridable like the budgets, because the right number is a property of the
 * operator's traffic.
 */
export const PREFIX_AFFINITY_TTL_MS = Math.max(1_000, Number(process.env.HUB_POOL_PREFIX_AFFINITY_TTL_MS) || 600_000);

/**
 * Most prefixes remembered at once; the least recently used is dropped past it. An entry is under
 * 200 bytes, so this is well under 1 MB, and a thousand concurrent sessions is more than any one Hub
 * on this fleet routes for.
 */
export const PREFIX_AFFINITY_CAPACITY = 1_000;

/** What one affinity decision produced — see `PoolRoutingAffinity.outcome` for the meaning of each. */
export type PrefixAffinityOutcome = 'hit' | 'miss' | 'skipped';

/** A session key and where it came from. Never logged: the header is the app's own identifier and the digest is of its prompt. */
export interface PrefixKey {
  source: 'header' | 'hashed';
  key: string;
}

/** Where a prefix was last placed. `node` is the routing log's label for it (`'local'` or the peer's FQDN). */
export interface PrefixAffinityEntry {
  nodeKey: string;
  node: string;
  backend: InferenceBackendType;
  at: number;
}

/**
 * An app-supplied session id, or `undefined` when there is none worth keeping.
 *
 * Held to the shape `normalizePoolRequestId` admits, widened to 128 characters and the punctuation
 * a chat or run id is likely to carry, so a value that reaches the affinity store is never
 * whitespace, a control character, or a megabyte. The header is an untrusted app's, and the only
 * thing it can do with a bad value is fall back to the hashed key. Express hands a repeated header
 * back as an array; the first value stands.
 */
export function normalizePoolSessionKey(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,127}$/.test(first) ? first : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The part of a prompt that names a session, as the parts the digest reads in order: the leading
 * `system` messages and the first message after them for a chat body, the `system` and `prompt`
 * fields for a completion or Ollama generate body. `null` when the body carries neither, in which
 * case there is nothing stable to key a session on and affinity stands aside.
 *
 * The head and not the whole `messages` array, because the array grows by a turn each call and a
 * digest of all of it would name every call differently. The system prompt alone is not enough
 * either: every session of one agent shares it byte for byte — tool schemas, instructions, memory —
 * and what tells them apart is the first turn after it. So the head ends at the first non-system
 * message, and {@link derivePrefixKey} digests every byte of both halves: a window over the head
 * collapses sessions again as soon as the system prompt outgrows it.
 *
 * A completion or generate body has no turn structure to stop at, so its `prompt` is digested whole.
 * An app that rebuilds the conversation into `prompt` each call therefore keys every call apart and
 * gets no affinity from the digest — never the wrong node, only the ranker's — and names its
 * session with the header instead.
 */
export function promptHead(body: unknown): unknown[] | null {
  if (!isRecord(body)) {
    return null;
  }
  if (Array.isArray(body.messages)) {
    const head: unknown[] = [];
    for (const message of body.messages) {
      head.push(message);
      if (!(isRecord(message) && message.role === 'system')) {
        break;
      }
    }
    return head.length > 0 ? head : null;
  }
  if (body.prompt !== undefined) {
    return [body.system ?? null, body.prompt];
  }
  return null;
}

/**
 * The key a request is remembered under, or `null` when there is nothing to key on.
 *
 * The model is part of both forms: a prefix cache is per loaded model, so the node that holds a
 * session's prefix for one model holds nothing useful for the same session on another. An app that
 * switches models mid-session starts a new affinity, which is what the engine sees too.
 *
 * The digest is one SHA-256 fed the head a part at a time, never a window over it — see
 * {@link promptHead} for why. Its cost is bounded by the forward, which serialises the whole body
 * once anyway. Each part goes in as its own JSON text behind a `\n`, which JSON never carries raw,
 * so where one part ends and the next begins is never in doubt.
 */
export function derivePrefixKey(model: string, body: unknown, sessionHeader: string | string[] | undefined): PrefixKey | null {
  const session = normalizePoolSessionKey(sessionHeader);
  if (session !== undefined) {
    return { source: 'header', key: `header:${model}\n${session}` };
  }
  const head = promptHead(body);
  if (head === null) {
    return null;
  }
  const hash = createHash('sha256').update(model);
  for (const part of head) {
    // `JSON.stringify(undefined)` is `undefined`, which `update` rejects. A parsed body never carries one; a hand-built one may.
    hash.update('\n').update(JSON.stringify(part) ?? 'null');
  }
  return { source: 'hashed', key: `hashed:${hash.digest('hex')}` };
}

/**
 * Where each recently seen prefix was last placed. Process-local and bounded, like the routing log
 * and the throughput store: a routing hint, never a record, and a restart forgets it.
 */
export class PrefixAffinityStore {
  private readonly entries = new Map<string, PrefixAffinityEntry>();

  constructor(
    private readonly ttlMs = PREFIX_AFFINITY_TTL_MS,
    private readonly capacity = PREFIX_AFFINITY_CAPACITY,
  ) {}

  /** The live entry for `key`, or `null`. An expired entry is dropped on the read rather than on a timer. */
  get(key: string, now = Date.now()): PrefixAffinityEntry | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (now - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  /**
   * Record that `candidate` is now working on `key`. Called as each attempt is placed, not when it
   * answers: a session's next call can arrive while this one is still prefilling — an agent's
   * parallel tool calls do — and it should follow to the engine already reading the shared prefix.
   * A later attempt after a failover overwrites, so the entry names the engine that actually took it.
   */
  remember(key: string, candidate: PoolCandidate, now = Date.now()): void {
    // Delete-then-set moves the key to the end of insertion order, which is what makes `entries`
    // an LRU: the first key is always the least recently written.
    this.entries.delete(key);
    this.entries.set(key, {
      nodeKey: candidate.peerId ?? LOCAL_CANDIDATE_KEY,
      node: candidate.nodeFqdn ?? LOCAL_CANDIDATE_KEY,
      backend: candidate.backend,
      at: now,
    });
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  /** Drop `key`: every candidate failed, so nothing holds its prefix and the next call should rank fresh. */
  forget(key: string): void {
    this.entries.delete(key);
  }

  /** Entries held, for tests and the status card. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Move the remembered candidate to the front of an already-ranked list when its queue is under the
 * limit. `sticky` is the ranked entry that matched, whatever was done with it, so the caller can say
 * what it saw; `ordered` is byte-identical to `ranked` unless something moved.
 *
 * Matched on node AND engine: two engines on one node have two caches, and the one that read the
 * prefix is the one worth returning to. `inFlight >= maxInFlight` rather than `>` because the count
 * is the node's queue before this request joins it, and the knob counts this request too — at 2 the
 * node takes the request when idle or with one other in flight, and hands it on at two or more. At 0
 * nothing can ever be under the limit, which is the switch.
 *
 * Pure and exported for its own test, like `applyPin`.
 */
export function applyPrefixAffinity<T extends { candidate: PoolCandidate; inFlight: number }>(
  ranked: readonly T[],
  remembered: Pick<PrefixAffinityEntry, 'nodeKey' | 'backend'> | null,
  maxInFlight: number,
): { ordered: T[]; sticky: T | null } {
  if (!remembered) {
    return { ordered: [...ranked], sticky: null };
  }
  const sticky =
    ranked.find(
      (entry) => (entry.candidate.peerId ?? LOCAL_CANDIDATE_KEY) === remembered.nodeKey && entry.candidate.backend === remembered.backend,
    ) ?? null;
  if (!sticky || sticky.inFlight >= maxInFlight) {
    return { ordered: [...ranked], sticky };
  }
  return { ordered: [sticky, ...ranked.filter((entry) => entry !== sticky)], sticky };
}
