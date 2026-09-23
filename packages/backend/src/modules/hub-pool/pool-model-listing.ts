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
