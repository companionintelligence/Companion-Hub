import { type StackUpdatePending, readStackUpdatePending, resolveStackUpdate } from './desktop-stack-session';

/**
 * What to do with a `hub_hello` — the first message on every app SSE stream, carrying the
 * running Hub's version.
 *
 * A stack update recreates the Hub container. The page's EventSource drops, reconnects
 * with backoff, and the reconnect that succeeds is the new Hub — so the hello is the push
 * signal that the update finished, and nothing has to poll. Two catches this decides:
 *
 * - The reconnect can land on the OLD container if it has not stopped yet. A hello with
 *   the version the update started from means "not yet", not "done".
 * - A same-origin tab is running the bundle the old Hub served. Once the Hub runs a
 *   different image than the one that built that bundle, it is stale (new hashed assets),
 *   so it reloads — once per image version.
 */

/** A hello from the pre-update version this long after the request means the recreate did not land. */
export const STACK_UPDATE_NOT_CONFIRMED_AFTER_MS = 10 * 60 * 1000;

/** Guards the stale-bundle reload to one per Hub version per tab session. */
const RELOADED_FOR_VERSION_KEY = 'ci-hub-reloaded-for-hub-version';

export type HubHelloDecision =
  | { kind: 'none' }
  | { kind: 'update_completed'; version: string }
  | { kind: 'update_not_confirmed'; version: string }
  /** `version` here is the running image's build stamp, which keys the once-per-version reload. */
  | { kind: 'bundle_stale'; version: string };

export interface HubHelloInput {
  helloVersion: string | null | undefined;
  /** The hello's `buildVersion`: the running image's build stamp. Absent on an unstamped image or an older Hub. */
  helloBuildVersion?: string | null;
  /** `import.meta.env.CI_HUB_VERSION` — the version this bundle was built as. */
  bundleVersion: string | null | undefined;
  pending: StackUpdatePending | null;
  /** True when the Hub serves this bundle (browser, same-origin desktop). Cross-origin desktop ships its own. */
  sameOriginBundle: boolean;
  now: number;
}

export function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim().replace(/^v/i, '') ?? '';
  return trimmed || null;
}

export function decideHubHello(input: HubHelloInput): HubHelloDecision {
  const hello = normalizeVersion(input.helloVersion);
  if (!hello) return { kind: 'none' };

  const bundle = normalizeVersion(input.bundleVersion);
  const { pending } = input;

  if (pending) {
    // The version the update started from: recorded on click; for a legacy marker the
    // bundle is the best proxy (a same-origin bundle IS the old Hub's UI).
    const baseline = normalizeVersion(pending.fromVersion) ?? (input.sameOriginBundle ? bundle : null);
    if (baseline === null || hello !== baseline) {
      return { kind: 'update_completed', version: hello };
    }
    if (pending.startedAt !== null && input.now - pending.startedAt > STACK_UPDATE_NOT_CONFIRMED_AFTER_MS) {
      return { kind: 'update_not_confirmed', version: hello };
    }
    return { kind: 'none' };
  }

  // Image builds give the bundle version and the build stamp the same value, so they differ only when
  // the Hub runs another image. `version` is the env file's: on a channel image or a drifted install it
  // never matches the bundle, so comparing with it would reload every new tab. No stamp, no reload.
  const build = normalizeVersion(input.helloBuildVersion);
  if (input.sameOriginBundle && bundle && build && bundle !== build) {
    return { kind: 'bundle_stale', version: build };
  }
  return { kind: 'none' };
}

export interface HubHelloEffects {
  /** Refetch the app context so `version.current` reflects the Hub that just answered. */
  invalidateVersion: () => void;
  reload: () => void;
}

/** True the first time this tab session is asked to reload for `version`; false on every repeat. */
function claimReloadForVersion(version: string): boolean {
  try {
    if (sessionStorage.getItem(RELOADED_FOR_VERSION_KEY) === version) return false;
    sessionStorage.setItem(RELOADED_FOR_VERSION_KEY, version);
    return true;
  } catch {
    // No storage means no guard; one reload is still better than a stale bundle, but not a loop.
    return false;
  }
}

/** Apply a `hub_hello`: decide, then run the side effects that decision calls for. */
export function applyHubHello(
  helloVersion: string | null | undefined,
  context: Pick<HubHelloInput, 'bundleVersion' | 'helloBuildVersion' | 'sameOriginBundle'> & { now?: number },
  effects: HubHelloEffects,
): HubHelloDecision {
  const decision = decideHubHello({
    helloVersion,
    helloBuildVersion: context.helloBuildVersion,
    bundleVersion: context.bundleVersion,
    sameOriginBundle: context.sameOriginBundle,
    pending: readStackUpdatePending(),
    now: context.now ?? Date.now(),
  });

  switch (decision.kind) {
    case 'update_completed': {
      resolveStackUpdate({ state: 'completed', version: decision.version });
      effects.invalidateVersion();
      const bundle = normalizeVersion(context.bundleVersion);
      if (context.sameOriginBundle && bundle !== decision.version && claimReloadForVersion(decision.version)) {
        effects.reload();
      }
      break;
    }
    case 'update_not_confirmed':
      resolveStackUpdate({ state: 'not_confirmed', version: decision.version });
      effects.invalidateVersion();
      break;
    case 'bundle_stale':
      if (claimReloadForVersion(decision.version)) {
        effects.reload();
      }
      break;
    case 'none':
      break;
  }
  return decision;
}
