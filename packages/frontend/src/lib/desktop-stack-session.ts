/** Session flag: hub reached Running at least once this tab session (tolerate brief probe blips). */
const HUB_STEADY_SESSION_KEY = 'ci-hub-steady-running';

/**
 * Set when the user triggers a stack pull/recreate; cleared when the new Hub's `hub_hello`
 * arrives on the app SSE stream (see `hub-hello.ts`) or, on the desktop gate, after the
 * reconnect reload. The value is JSON with the version the update started from, so the
 * hello can tell "the update landed" from "the old container is still answering". A bare
 * `'1'` is the pre-JSON shape and is read as pending with an unknown baseline.
 */
const STACK_UPDATE_PENDING_KEY = 'ci-hub-stack-update-pending';

/** DOM event carrying a {@link StackUpdateOutcome}; the Settings panel subscribes to it. */
const STACK_UPDATE_EVENT = 'ci-hub:stack-update';

/**
 * The outcome of an update that ends in a page reload. The reload swaps the old Hub's bundle for the
 * new one and wipes the page's state, so the event above reaches nobody who can still show it.
 */
const STACK_UPDATE_KEPT_OUTCOME_KEY = 'ci-hub-stack-update-outcome';

export interface StackUpdatePending {
  /** Hub version when the update was requested, when the marker recorded one. */
  fromVersion: string | null;
  /** Epoch ms when the update was requested, when the marker recorded one. */
  startedAt: number | null;
}

export type StackUpdateOutcome =
  | { state: 'completed'; version: string }
  /** The Hub came back on the version it left on, well after the request — the recreate did not land. */
  | { state: 'not_confirmed'; version: string };

export function readHubSteadySession(): boolean {
  try {
    return sessionStorage.getItem(HUB_STEADY_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHubSteadySession(): void {
  try {
    sessionStorage.setItem(HUB_STEADY_SESSION_KEY, '1');
  } catch {
    // sessionStorage unavailable — steady-state hints are best-effort only.
  }
}

export function clearHubSteadySession(): void {
  try {
    sessionStorage.removeItem(HUB_STEADY_SESSION_KEY);
  } catch {
    // ignore
  }
}

export function markStackUpdatePending(fromVersion?: string | null, now: number = Date.now()): void {
  try {
    const record: StackUpdatePending = { fromVersion: fromVersion?.trim() || null, startedAt: now };
    sessionStorage.setItem(STACK_UPDATE_PENDING_KEY, JSON.stringify(record));
  } catch {
    // ignore
  }
}

export function readStackUpdatePending(): StackUpdatePending | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(STACK_UPDATE_PENDING_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (raw === '1') return { fromVersion: null, startedAt: null };
  try {
    const parsed = JSON.parse(raw) as Partial<StackUpdatePending> | null;
    if (!parsed || typeof parsed !== 'object') return { fromVersion: null, startedAt: null };
    return {
      fromVersion: typeof parsed.fromVersion === 'string' && parsed.fromVersion ? parsed.fromVersion : null,
      startedAt: typeof parsed.startedAt === 'number' && Number.isFinite(parsed.startedAt) ? parsed.startedAt : null,
    };
  } catch {
    return { fromVersion: null, startedAt: null };
  }
}

export function isStackUpdatePending(): boolean {
  return readStackUpdatePending() !== null;
}

export function clearStackUpdatePending(): void {
  try {
    sessionStorage.removeItem(STACK_UPDATE_PENDING_KEY);
  } catch {
    // ignore
  }
}

/** Clear the marker and tell subscribers how the update ended. */
export function resolveStackUpdate(outcome: StackUpdateOutcome): void {
  clearStackUpdatePending();
  window.dispatchEvent(new CustomEvent<StackUpdateOutcome>(STACK_UPDATE_EVENT, { detail: outcome }));
}

/** Keep an outcome for the first Settings panel to mount after a reload. */
export function keepStackUpdateOutcome(outcome: StackUpdateOutcome): void {
  try {
    sessionStorage.setItem(STACK_UPDATE_KEPT_OUTCOME_KEY, JSON.stringify(outcome));
  } catch {
    // ignore
  }
}

export function readKeptStackUpdateOutcome(): StackUpdateOutcome | null {
  try {
    const raw = sessionStorage.getItem(STACK_UPDATE_KEPT_OUTCOME_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StackUpdateOutcome> | null;
    if ((parsed?.state === 'completed' || parsed?.state === 'not_confirmed') && typeof parsed.version === 'string') {
      return { state: parsed.state, version: parsed.version };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearKeptStackUpdateOutcome(): void {
  try {
    sessionStorage.removeItem(STACK_UPDATE_KEPT_OUTCOME_KEY);
  } catch {
    // ignore
  }
}

/** Subscribe to {@link resolveStackUpdate}; returns the unsubscribe. */
export function subscribeStackUpdate(listener: (outcome: StackUpdateOutcome) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<StackUpdateOutcome>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(STACK_UPDATE_EVENT, handler);
  return () => window.removeEventListener(STACK_UPDATE_EVENT, handler);
}
