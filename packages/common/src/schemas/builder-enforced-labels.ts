import type { z } from 'zod';
import { TRAEFIK_LABEL_REFUSALS } from './traefik-labels.js';

/**
 * The label refusals the compose builder enforces on its own. `DockerComposeBuilder` leaves these
 * labels out of every compose it writes, whatever the schema said, and logs each one. So a compose
 * already on the Hub that holds one can still start, and the editor can still open it so the label
 * can be removed. A save still refuses it.
 *
 * Every other refusal (privileged, a denied host path and the rest) stays fatal wherever the compose
 * is read: the builder has no way to leave those out.
 */
export const BUILDER_ENFORCED_LABEL_REFUSALS: ReadonlySet<string> = new Set(['CUSTOM_APP_ERROR_LABEL_RESERVED', ...TRAEFIK_LABEL_REFUSALS]);

type IssueLike = { message: string; path: readonly PropertyKey[] };

/** A refusal of one `extraLabels` key that the builder enforces itself. */
export function isBuilderEnforcedLabelIssue(issue: IssueLike): boolean {
  const { path } = issue;
  return (
    BUILDER_ENFORCED_LABEL_REFUSALS.has(issue.message) &&
    path.length >= 2 &&
    path[path.length - 2] === 'extraLabels' &&
    typeof path[path.length - 1] === 'string'
  );
}

export type KeptLabelsParseResult<T> = { success: true; data: T; labelIssues: z.core.$ZodIssue[] } | { success: false; error: z.ZodError };

/**
 * Enough for a compose's services and then its overrides, whose check only runs once the services
 * pass, with room to spare.
 */
const MAX_PASSES = 4;

/**
 * `schema.safeParse(data)` for a compose that is already on the Hub, which forgives only the label
 * refusals the builder enforces itself ({@link isBuilderEnforcedLabelIssue}).
 *
 * Those labels are set aside, the rest is parsed again and the labels are put back into `data` as
 * they were stored, so the builder decides on them and logs them as it does for a compose that
 * never met the schema. The refusals come back in `labelIssues`, for the editor to show. Any other
 * refusal fails the parse as `safeParse` does. `data` itself is never changed.
 */
export function safeParseKeepingBuilderEnforcedLabels<T extends z.ZodType>(schema: T, data: unknown): KeptLabelsParseResult<z.output<T>> {
  const labelIssues: z.core.$ZodIssue[] = [];
  let input = data;
  let result = schema.safeParse(input);
  for (let pass = 1; !result.success && pass < MAX_PASSES; pass += 1) {
    if (!result.error.issues.every(isBuilderEnforcedLabelIssue)) {
      return { success: false, error: result.error };
    }
    if (input === data) {
      // Compose configs are JSON, so a JSON copy is a full one.
      input = JSON.parse(JSON.stringify(data));
    }
    for (const issue of result.error.issues) {
      const parent = containerAt(input, issue.path);
      const key = issue.path[issue.path.length - 1] as string;
      if (parent && Object.hasOwn(parent, key)) {
        delete parent[key];
      }
      labelIssues.push(issue);
    }
    result = schema.safeParse(input);
  }
  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Each label map that lost a key gets the stored one back, in its stored order. Every other entry
  // passed the parse unchanged, since a label is a plain string or boolean.
  const restored = new Set<Record<PropertyKey, unknown>>();
  for (const issue of labelIssues) {
    const stored = containerAt(data, issue.path);
    const parsed = containerAt(result.data, issue.path);
    if (!stored || !parsed || restored.has(parsed)) {
      continue;
    }
    restored.add(parsed);
    for (const key of Object.keys(parsed)) {
      delete parsed[key];
    }
    for (const [key, value] of Object.entries(stored)) {
      // Defined rather than assigned, so no key can reach a setter on the object.
      Object.defineProperty(parsed, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return { success: true, data: result.data, labelIssues };
}

/** The object holding the last key of `path` under `root`, if every step is an object. */
function containerAt(root: unknown, path: readonly PropertyKey[]): Record<PropertyKey, unknown> | undefined {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (node === null || typeof node !== 'object') {
      return undefined;
    }
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node !== null && typeof node === 'object' ? (node as Record<PropertyKey, unknown>) : undefined;
}
