import { sameModelId } from '@/common/helpers/hub-pool';

/**
 * Merging the pool's model inventory into the two listing endpoints.
 *
 * `GET /v1/models` and `GET /api/tags` carry no `model` field, so they cannot be routed the way a
 * completion is — `proxyLocalOnlyRequest` serves them from the first local backend that answers.
 * That made the listing a statement about this node while every generation path had already become
 * a statement about the pool: a client asked what it could run, was told this node's models, and
 * then found that a model it had never been offered served fine, because a peer held it. A Hub with
 * no local engine answered 502 to the listing while its peers held a dozen models.
 *
 * So the peer half is added here. It costs no network I/O: a peer's inventory is already in
 * `hub_pool_peer.last_capabilities`, refreshed by the health poll (30 s by default), which is the
 * same snapshot candidate ranking reads. A listing and a subsequent completion therefore agree by
 * construction — if this says a model is available, the ranker saw the same row.
 *
 * What a merged-in entry cannot carry is metadata. A peer advertises model *names* and nothing else
 * (`PoolPeerBackendCapability.modelsLoaded`), so size, digest, and modified time are unknown for a
 * model no local engine holds. They are emitted as the empty/zero value their field requires rather
 * than invented, and `owned_by` names the pool on the OpenAI side so a client that looks can tell
 * the two apart. Omitting the model entirely would be worse: the caller's real question is what it
 * may ask for, and the answer is yes.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(row: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(row)) return undefined;
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** `owned_by` on a model this node does not hold, so a client that reads the field can tell. */
export const POOL_OWNED_BY = 'hub-pool';

/** The two paths this module merges. Anything else goes through `proxyLocalOnlyRequest` untouched. */
export const MERGED_LISTING_PATHS: ReadonlySet<string> = new Set(['/v1/models', '/api/tags']);

/** Model ids already present in a local `/v1/models` or `/api/tags` body. */
export function listedModelIds(path: string, body: unknown): string[] {
  if (!isRecord(body)) return [];
  const rows = path === '/v1/models' ? body.data : body.models;
  if (!Array.isArray(rows)) return [];
  const ids: string[] = [];
  for (const row of rows) {
    // OpenAI names it `id`; Ollama names it `model` and repeats it in `name` (with the tag).
    const id = path === '/v1/models' ? stringField(row, 'id') : stringField(row, 'model', 'name');
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Models some peer serves that the local listing does not already name.
 *
 * Folded through `sameModelId`, which is what candidate matching uses, so `qwen3:8b` and
 * `qwen3:8b:latest` never both appear — the listing must not offer one model twice under two
 * spellings when a completion would treat them as one.
 */
export function peerOnlyModels(localIds: readonly string[], peerModels: readonly string[]): string[] {
  const merged: string[] = [];
  for (const model of peerModels) {
    const known = localIds.some((id) => sameModelId(id, model)) || merged.some((id) => sameModelId(id, model));
    if (!known) merged.push(model);
  }
  return merged;
}

/**
 * Several local backends' listings as one body, in the order given (the caller's backend order).
 *
 * The listing used to be the FIRST local backend that answered, and Ollama answers first — so on a
 * node running Ollama beside Lemonade, `/v1/models` never named a Lemonade model, and an app handed a
 * Lemonade chat model (ci-memory, 2026-09-29: `Qwen3.8-27B-GGUF`) rejected it as "Invalid model
 * specified" on every job, although a completion for it would have routed and served fine. Unlike a
 * peer's, a local backend's rows are real — size, digest, `details` — so they are kept whole. A model
 * two backends both hold appears once, as the earlier backend's row, folded through `sameModelId`
 * like everything else here. The first body's other fields (`object` and the like) are kept.
 */
export function mergeLocalListings(path: string, bodies: readonly unknown[]): unknown {
  const [first, ...rest] = bodies;
  if (rest.length === 0) return first ?? null;
  const key = path === '/v1/models' ? 'data' : 'models';
  const base = isRecord(first) ? first : {};
  const rows: unknown[] = Array.isArray(base[key]) ? [...(base[key] as unknown[])] : [];
  const ids = listedModelIds(path, first);
  for (const body of rest) {
    const bodyRows = isRecord(body) && Array.isArray(body[key]) ? (body[key] as unknown[]) : [];
    for (const row of bodyRows) {
      const id = path === '/v1/models' ? stringField(row, 'id') : stringField(row, 'model', 'name');
      if (!id || ids.some((known) => sameModelId(known, id))) continue;
      ids.push(id);
      rows.push(row);
    }
  }
  return path === '/v1/models' ? { ...base, object: 'list', data: rows } : { ...base, models: rows };
}

/**
 * How long a merged listing waits for each healthy local backend before it answers without the ones
 * still out. A listing is an inventory read, which a working engine answers at once: measured on
 * 2026-09-30 from the host, Ollama `/api/tags` and `/v1/models` took at most 2.2 ms on beta-red and
 * beta-1, and Lemonade 10.2.0 `/v1/models` under 0.5 ms. A client may fetch the listing before every
 * request (ci-server checks its model against it per call), and it used to wait for the slowest
 * engine the health snapshot still called healthy: one wedged engine held every app's listing for as
 * long as the forward budget allows a completion, five minutes by default.
 */
export const LOCAL_LISTING_DEADLINE_MS = 2_500;

/**
 * How old a backend's last listing may be and still stand in for it when it misses
 * `LOCAL_LISTING_DEADLINE_MS`. Without a stand-in, a healthy engine that is slow for a moment takes
 * every model it holds out of the listing for that moment, and ci-server, which checks its model
 * against the listing on every call, calls a model it has been using absent. An inventory changes only
 * on a pull or a delete, so what the engine answered a few minutes ago is still what it holds. The cap
 * bounds how long an engine that has stopped answering listings, while the health snapshot still calls
 * it healthy, keeps its models offered. Five minutes is the forward budget's default, which is as long
 * as the listing waited for such an engine before it had a deadline at all.
 */
export const LOCAL_LISTING_STAND_IN_MAX_AGE_MS = 5 * 60_000;

/**
 * Every backend's listing body, asked in parallel, in `backends` order (the order the merge keeps),
 * without waiting past `deadlineMs` for a backend once another has answered:
 *
 * - Every answer that arrives within the deadline is kept, however many there are.
 * - At the deadline, the backends still out are dropped: each is reported to `onDropped` and its
 *   request aborted through the signal `fetchOne` was given. What `onDropped` returns, if anything
 *   usable, is kept in the dropped backend's place (its last listing; see
 *   `LOCAL_LISTING_STAND_IN_MAX_AGE_MS`).
 * - When nothing has answered by the deadline, the first answer to arrive is kept and the rest are
 *   dropped then. A listing with one backend in it beats a listing that waits for them all, and an
 *   empty one would read as "no model here" to a client that would otherwise have waited.
 *
 * `null` from `fetchOne` (or a rejection) is a backend that answered with nothing usable: it is not
 * kept, does not count as an answer, and gets no stand-in, since it did answer. The result is empty
 * only when no backend answered at all.
 */
export function gatherListings<Backend>(
  backends: readonly Backend[],
  fetchOne: (backend: Backend, signal: AbortSignal) => Promise<unknown>,
  deadlineMs: number,
  onDropped: (backend: Backend) => unknown,
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const controllers = backends.map(() => new AbortController());
    // `undefined` while a backend is still out; `null` once it answered with nothing usable.
    const answers: unknown[] = backends.map(() => undefined);
    let outstanding = backends.length;
    let pastDeadline = false;
    let settled = false;
    const usable = (answer: unknown) => answer !== undefined && answer !== null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      backends.forEach((backend, index) => {
        if (answers[index] === undefined) {
          controllers[index]?.abort(new Error(`No listing within ${deadlineMs}ms while another backend had answered`));
          // The aborted request settles later, finds the gather settled and leaves this alone.
          answers[index] = onDropped(backend) ?? null;
        }
      });
      resolve(answers.filter(usable));
    };
    const timer = setTimeout(() => {
      pastDeadline = true;
      if (answers.some(usable)) finish();
    }, deadlineMs);
    if (backends.length === 0) {
      finish();
      return;
    }
    backends.forEach((backend, index) => {
      const signal = (controllers[index] as AbortController).signal;
      fetchOne(backend, signal)
        .catch(() => null)
        .then((answer) => {
          if (settled) return;
          answers[index] = answer ?? null;
          outstanding -= 1;
          if (outstanding === 0 || (pastDeadline && usable(answer))) finish();
        });
    });
  });
}

/** An OpenAI `/v1/models` row for a model only a peer holds. `created` is required by the shape; 0 says "unknown". */
function openAiRow(model: string): Record<string, unknown> {
  return { id: model, object: 'model', created: 0, owned_by: POOL_OWNED_BY };
}

/**
 * An Ollama `/api/tags` row for a model only a peer holds.
 *
 * `size` and `digest` are the peer's to know and it does not publish them. Zero and the empty string
 * are what this shape's consumers already tolerate for an unknown value; a fabricated size would be
 * read as fact by anything doing disk arithmetic. `details` is present but empty for the same
 * reason — clients index into it, so its absence crashes more of them than its emptiness does.
 */
function ollamaRow(model: string): Record<string, unknown> {
  return {
    name: model,
    model,
    modified_at: null,
    size: 0,
    digest: '',
    details: {},
  };
}

/**
 * The local body with peer-only models appended, or a freshly built body when there was no local
 * answer at all (a Hub whose own engines are down or absent, whose peers can still serve).
 */
export function mergeModelListing(path: string, localBody: unknown, peerOnly: readonly string[]): Record<string, unknown> {
  const rows = peerOnly.map((model) => (path === '/v1/models' ? openAiRow(model) : ollamaRow(model)));

  if (path === '/v1/models') {
    const existing = isRecord(localBody) && Array.isArray(localBody.data) ? localBody.data : [];
    return { ...(isRecord(localBody) ? localBody : {}), object: 'list', data: [...existing, ...rows] };
  }

  const existing = isRecord(localBody) && Array.isArray(localBody.models) ? localBody.models : [];
  return { ...(isRecord(localBody) ? localBody : {}), models: [...existing, ...rows] };
}
