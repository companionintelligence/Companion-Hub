/**
 * How eval work is ORDERED and ACCOUNTED FOR — pure decisions, no I/O.
 *
 * Both rules here exist because of the same measured defect, and both fail SILENTLY, which is why
 * they are unit-testable rather than left inline in a dispatcher:
 *
 *  1. ORDER. Work used to be appended one endpoint at a time — every Ollama item, then every mtplx
 *     item, then every dspark item — into ONE FIFO queue drained by a small worker pool. That makes
 *     coverage a function of position: on a host running all three side by side, a run showed 57/57
 *     Ollama rows, 2/36 mtplx rows and ZERO dspark rows for the first ten minutes — dspark was
 *     healthy, reachable and queued the whole time. An operator reading that results file cannot tell
 *     "not measured yet" from "never became work", and a run stopped or interrupted before the tail
 *     is reached has 100% coverage of one backend and 0% of another. Interleaving makes partial
 *     progress proportional instead: every backend advances together, so the FIRST few rows already
 *     say something about all of them.
 *
 *  2. ACCOUNTING. An endpoint the probe DID find is not missing, so it gets no absent-skip row. If
 *     the run's prompt selection then targets none of that backend — an embeddings-only selection
 *     names 0 of mtplx/dspark/lucebox, because none of the three serves `/v1/embeddings` — the
 *     endpoint contributes no rows of any kind. A backend vanishing without a trace is
 *     indistinguishable from one nobody selected, which is the exact ambiguity an eval exists to
 *     remove: it must say "found it, had nothing to ask it", with the numbers that make that
 *     checkable.
 */

import type { InferenceBackendType } from '@ci-hub/common/types';

/**
 * The shape the ordering rule needs.
 *
 * The lane key is a plain `string` rather than the backend union on purpose: interleaving is a
 * property of the queue, not of inference, and a caller whose items carry a wider tag (a synthetic
 * lane, a per-endpoint key on a host running two of the same backend) must not have to cast to get
 * fair ordering.
 */
export interface BackendTagged {
  backend: string;
}

/**
 * Round-robin items across backends, preserving each backend's own order.
 *
 * One pass per rank: the first item of every backend, then the second of every backend, and so on.
 * Backend order is first-seen, so a single-backend queue comes back byte-identical and a run against
 * one endpoint is unaffected. Sibling items that must run together do not need to stay adjacent —
 * a worker that pulls a whole group out of the queue finds its members wherever they sit — so this is
 * safe for fanout entries.
 */
export function interleaveByBackend<T extends BackendTagged>(items: readonly T[]): T[] {
  const lanes = new Map<string, T[]>();
  for (const item of items) {
    const lane = lanes.get(item.backend);
    if (lane) lane.push(item);
    else lanes.set(item.backend, [item]);
  }
  const ordered = [...lanes.values()];
  const out: T[] = [];
  for (let rank = 0; out.length < items.length; rank++) {
    for (const lane of ordered) {
      const next = lane[rank];
      if (next !== undefined) out.push(next);
    }
  }
  return out;
}

export interface EndpointCoverage {
  /** Where the backend answered — a host:port or an operator-supplied label, never a roster name. */
  endpoint: string;
  backend: InferenceBackendType;
  /** How the endpoint was identified: discovery, an explicit configuration entry, a fingerprint. */
  via: string;
  /** How many prompts this run selected. */
  selected: number;
  /** How many of them name this backend. */
  applicable: number;
}

/**
 * The reason a DISCOVERED endpoint produced no work, or null when it produced some.
 *
 * Null means "this endpoint has work, let it speak for itself". A string means the run found the
 * backend and had nothing to ask it — which is a legitimate outcome, but only when it is stated. The
 * counts are in the sentence on purpose: "0 of 8 selected prompts" tells an operator to widen the
 * selection, where a bare "skipped" tells them nothing they can act on.
 */
export function endpointCoverageSkip(c: EndpointCoverage): string | null {
  if (c.applicable > 0) return null;
  return (
    `${c.backend} answered on ${c.endpoint} (via ${c.via}) but 0 of the ${c.selected} selected prompt(s) target it — ` +
    'nothing to run, not a failure. Select a prompt this backend serves to measure it.'
  );
}
