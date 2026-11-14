import type { TFunction } from 'i18next';

/**
 * The `(key, vars) => string` call shape the app's translation helpers take. i18next 27 types `t` with generic
 * overloads that are not assignable to it, so a helper receives `asLegacyTranslate(t)` instead.
 */
export type LegacyTranslate = (key: string, vars?: Record<string, unknown>) => string;

const adapters = new WeakMap<TFunction, LegacyTranslate>();

/**
 * Adapts an i18next `t` to {@link LegacyTranslate}. A call forwards to `t`; a missing `vars` is passed as `{}`, which
 * i18next handles the same as passing nothing. Memoised per `t`, so a value built from it (a hook option, a prop)
 * keeps its identity across renders, as `t` does.
 */
export function asLegacyTranslate(t: TFunction): LegacyTranslate {
  let adapter = adapters.get(t);
  if (!adapter) {
    adapter = (key, vars) => t(key, vars ?? {});
    adapters.set(t, adapter);
  }
  return adapter;
}
