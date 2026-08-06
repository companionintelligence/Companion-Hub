/** Session flag: hub reached Running at least once this tab session (tolerate brief probe blips). */
const HUB_STEADY_SESSION_KEY = 'ci-hub-steady-running';

/** Set when the user triggers a stack pull/recreate; cleared after reconnect reload. */
const STACK_UPDATE_PENDING_KEY = 'ci-hub-stack-update-pending';

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

export function markStackUpdatePending(): void {
  try {
    sessionStorage.setItem(STACK_UPDATE_PENDING_KEY, '1');
  } catch {
    // ignore
  }
}

export function isStackUpdatePending(): boolean {
  try {
    return sessionStorage.getItem(STACK_UPDATE_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearStackUpdatePending(): void {
  try {
    sessionStorage.removeItem(STACK_UPDATE_PENDING_KEY);
  } catch {
    // ignore
  }
}
