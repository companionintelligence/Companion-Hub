/**
 * How oMLX (github.com/jundot/omlx) names a model, so the Hub can tell which of its listings is a catalog row.
 *
 * The catalog spells an oMLX model as its Hugging Face repo id, `mlx-community/Qwen3-8B-4bit`. oMLX lists that
 * spelling only when an operator aliased a model to it. Measured on oMLX 0.7.3.dev1, `GET /v1/models` for one
 * 4-bit model laid out each way:
 *
 *   <model dir>/Qwen3-8B-4bit/                    → `Qwen3-8B-4bit`                (the directory's own name)
 *   <model dir>/mlx-community/Qwen3-8B-4bit/      → `Qwen3-8B-4bit`                (an organization folder is dropped)
 *   Hugging Face cache `models--mlx-community--Qwen3-8B-4bit`  → `mlx-community--Qwen3-8B-4bit`
 *   any of the above with a `model_alias` set     → the alias, which hides the model's own name
 *
 * (`discover_models` and `_decode_hf_cache_model_id` in omlx/model_discovery.py.) The listing holds the models oMLX
 * has discovered, loaded or not, less any the operator hid: it named the model the same way before and after the
 * first request.
 *
 * A request is more forgiving than the listing, but not by much. oMLX tries the id as sent, then case-insensitively,
 * then, for an id with a `/`, the part after the first slash (`resolve_model_id` in omlx/engine_pool.py). So
 * `mlx-community/Qwen3-8B-4bit` is served from both directory layouts and answered with a 404 from the cache, where
 * only `mlx-community--Qwen3-8B-4bit` is a name. (With `model_fallback` on, oMLX serves its default model instead of
 * answering 404, so a wrong name is not even an error.) The Hub therefore names a model by the id oMLX lists.
 */

/** An oMLX model id split into the organization it carries, if any, and the model's own name. */
function splitOmlxId(id: string): { org: string | null; name: string } {
  const slash = id.indexOf('/');
  if (slash >= 0) return { org: id.slice(0, slash) || null, name: id.slice(slash + 1) };
  // A Hugging Face cache id. Hugging Face bars `--` from repo ids, so the first one always ends the organization.
  const cache = id.indexOf('--');
  if (cache > 0) return { org: id.slice(0, cache), name: id.slice(cache + 2) };
  return { org: null, name: id };
}

/**
 * The model's own name in any spelling oMLX uses, lower-cased and without its organization.
 *
 * Coarser than {@link omlxModelsMatch}, for keying a set or a map, where one string has to stand for each model: it
 * cannot compare organizations. Two ids with one key can still be two publishers' builds of a model.
 */
export function omlxModelKey(id: string): string {
  return splitOmlxId(id).name.toLowerCase();
}

/**
 * Whether two ids name one model: the same name, ignoring case as oMLX does when it resolves a request, and the same
 * organization where both carry one. An id with no organization (a model directory's own name) matches any.
 *
 * That oMLX lists `Qwen3-8B-4bit` for a model directory and `mlx-community--Qwen3-8B-4bit` for the cache is what makes
 * them one model to the Hub. oMLX itself does not fold the two: it answers `Qwen3-8B-4bit` with a 404 when only the
 * cache entry is listed.
 */
export function omlxModelsMatch(a: string, b: string): boolean {
  const left = splitOmlxId(a);
  const right = splitOmlxId(b);
  if (!left.name || left.name.toLowerCase() !== right.name.toLowerCase()) return false;
  return left.org === null || right.org === null || left.org.toLowerCase() === right.org.toLowerCase();
}

/**
 * The id under which `served` (oMLX's `/v1/models` ids) lists the model the catalog calls `catalogId`, or null when it
 * lists none. A listing can hold the one model twice (a directory and a cache entry) and is sorted by id, so the order
 * of preference matters: the catalog's own spelling, then the bare name, then the cache spelling, each exactly, then any
 * other spelling that {@link omlxModelsMatch} accepts. A model behind a `model_alias` is listed under the alias alone
 * and is not found; another organization's build of the same name is not it.
 */
export function servedOmlxId(catalogId: string, served: Iterable<string>): string | null {
  const { org, name } = splitOmlxId(catalogId);
  if (!name) return null;
  const ids = [...served];
  for (const spelling of org === null ? [catalogId] : [catalogId, name, `${org}--${name}`]) {
    const exact = ids.find((id) => id === spelling);
    if (exact !== undefined) return exact;
  }
  return ids.find((id) => omlxModelsMatch(id, catalogId)) ?? null;
}
