/**
 * WHICH RESIDENT MODEL AN EVAL CASE RUNS AGAINST — pure ranking over names, no I/O.
 *
 * ── Why this is not ModelRegistryService.selectLlmsForHardware ──────────────────────────────────
 * They rank different things toward opposite goals, and collapsing them would break both:
 *
 *   selectLlmsForHardware   ranks CURATED_MODELS — catalog rows carrying a real memory footprint, a
 *                           parameter scale and a GPU-vendor list — against a hardware budget, and
 *                           answers "what is the BEST model this machine should install and serve".
 *                           Bigger is better, up to the budget.
 *
 *   pickModel (here)        ranks opaque NAME STRINGS a probe just read off a live endpoint. There is
 *                           no catalog row for most of them, no footprint, no hardware profile — only
 *                           what the endpoint says it is holding. It answers "which of these can I ask
 *                           a question with the least collateral damage". SMALLER is better.
 *
 * The smallest-first bias is the load-safety rule of the eval, not a quality judgement: these runs go
 * against endpoints doing real work, and a 70B pulled into VRAM to answer "what colour is the sky" is
 * exactly the collateral load an eval must not create.
 *
 * SAFETY: nothing here can install a model. Every function only ever ranks strings that were already
 * resident. A role with no resident candidate returns null, and the caller turns that into a skip row
 * carrying its reason (see `modelSkipNote` in selection-filters.ts) — never a pass, never a zero.
 */

import type { LlmModelRole } from './prompt-bank';

/**
 * How to treat Apple-MLX model builds when an endpoint has them.
 *   prefer — pick the MLX build when one exists for the role (default)
 *   both   — emit BOTH an MLX and a non-MLX case for the same prompt, so the two are measured on the
 *            same endpoint, same prompt, same minute. The only honest way to compare the two paths.
 *   off    — ignore the MLX-ness of a name entirely
 */
export type MlxPolicy = 'prefer' | 'both' | 'off';

export const MLX_POLICIES: readonly MlxPolicy[] = ['prefer', 'both', 'off'];

/** Which half of an A/B a case is measuring. null = the policy chose, no A/B. */
export type ModelVariant = 'mlx' | 'std';

/**
 * Is this model name an MLX build?
 *
 * Word-boundary match on purpose. Ollama's MLX builds are tagged `…-mlx` (`qwen3.5:9b-mlx`) and
 * HF-shaped ids carry the org (`mlx-community/…`), while a model whose name merely CONTAINS the
 * letters — there is no such model today, but names are not ours to control — must not be
 * mislabelled, because a wrong label silently poisons the MLX-vs-ordinary comparison rather than
 * failing it.
 *
 * One definition, imported by anything that badges or groups MLX builds: a badge that disagrees with
 * the policy that picked the model is worse than no badge.
 */
export function isMlxBuild(model: string | null | undefined): boolean {
  return /\bmlx\b/i.test(String(model ?? ''));
}

/**
 * Name-only guess at whether a model embeds rather than chats.
 *
 * A heuristic on purpose: these names come off a live endpoint's model list, not from a catalog, so
 * there is no modality field to read. It is used to CHOOSE a candidate, never to assert one — an
 * embedding prompt sent to a chat model fails its assertion loudly, which is the failure mode this
 * can afford.
 */
const isEmbeddingName = (m: string): boolean => /embed|bge|gte|e5-|minilm/i.test(m);

/**
 * Declared parameter count from the tag (`…:1b`, `-7b`, `32b`), or a large sentinel when the name is
 * silent — a model that will not say how big it is sorts last, so an unlabelled name is never picked
 * over one that declared itself small.
 */
const UNDECLARED_SIZE_B = 1000;

function declaredSizeB(model: string): number {
  const match = model.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  return match?.[1] ? Number(match[1]) : UNDECLARED_SIZE_B;
}

/** Candidate models for a role, in the endpoint's own listing order. */
export function candidatesForRole(models: readonly string[], role: LlmModelRole): string[] {
  return role === 'embedding' ? models.filter(isEmbeddingName) : models.filter((m) => !isEmbeddingName(m));
}

export interface PickModelOptions {
  /** Operator pin. Exact id, or the bare name before the `:tag`. Beats every other rule below. */
  forced?: string | null;
  /** Default 'prefer'. Ignored when `variant` is set — an explicit A/B half beats the policy. */
  policy?: MlxPolicy;
  /** Restrict to one side of the MLX A/B. Returns null when that side has no candidate. */
  variant?: ModelVariant | null;
}

/**
 * Choose a resident model for a role, or null when this endpoint holds none.
 *
 * Ranking, in order: an operator pin wins outright; then MLX-ness when the policy asks for it (an MLX
 * build is the entire reason for including an Apple-silicon target, and its small builds are still
 * small); then the smallest declared size; then the shorter name, purely so the result is
 * deterministic for two candidates that tie.
 */
export function pickModel(models: readonly string[], role: LlmModelRole, opts: PickModelOptions = {}): string | null {
  const policy = opts.policy ?? 'prefer';
  let pool = candidatesForRole(models, role);
  if (opts.variant === 'mlx') pool = pool.filter(isMlxBuild);
  else if (opts.variant === 'std') pool = pool.filter((m) => !isMlxBuild(m));
  if (pool.length === 0) return null;

  if (opts.forced) {
    const forced = opts.forced;
    return pool.find((m) => m === forced || m.startsWith(`${forced}:`)) ?? null;
  }

  // 'both' ranks like 'prefer' when it is asked for a single pick (no variant): the caller that wants
  // the A/B asks for each half explicitly, and a role with only one side falls back to this ranking.
  const mlxFirst = policy !== 'off' && opts.variant == null;
  return (
    [...pool].sort((a, b) => {
      if (mlxFirst) {
        const d = Number(isMlxBuild(b)) - Number(isMlxBuild(a));
        if (d !== 0) return d;
      }
      return declaredSizeB(a) - declaredSizeB(b) || a.length - b.length;
    })[0] ?? null
  );
}

/**
 * Under `policy: 'both'`, the two halves of the A/B for a role — or null when this endpoint cannot run
 * one (no MLX build, or nothing but MLX builds).
 *
 * Returning null rather than a degenerate pair is what keeps the comparison honest: a "comparison" of
 * a model against itself is worse than no row at all, because it reports a difference of zero as if
 * that were a measurement.
 */
export function mlxAbPair(models: readonly string[], role: LlmModelRole, forced?: string | null): { mlx: string; std: string } | null {
  const mlx = pickModel(models, role, { forced, variant: 'mlx' });
  const std = pickModel(models, role, { forced, variant: 'std' });
  return mlx && std && mlx !== std ? { mlx, std } : null;
}
