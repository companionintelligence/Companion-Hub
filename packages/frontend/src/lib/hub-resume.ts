/** How long desktop bootstrap will wait on a hung `/api/user-context` or registration call. */
export const HUB_BOOTSTRAP_FETCH_MS = 8_000;

/** After this long hidden, coming back should kick loaders instead of sitting on a dead socket. */
export const HUB_IDLE_RESUME_MS = 15_000;

const RESUME_RELOAD_GUARD = 'ci-hub-idle-resume-reload';

/**
 * Resolve `fallback` when `work` has not settled. Used so a half-open TCP
 * connection after the laptop sleeps cannot pin the UI on "Connecting to local API...".
 */
export async function firstOf<T>(work: Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = globalThis.setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  }
}

export function subscribeHubResume(onResume: () => void, idleMs = HUB_IDLE_RESUME_MS): () => void {
  if (typeof document === 'undefined') {
    return () => undefined;
  }

  let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : 0;

  const maybeResume = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }

    if (hiddenAt > 0 && Date.now() - hiddenAt >= idleMs) {
      onResume();
    }
    hiddenAt = 0;
  };

  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted || (hiddenAt > 0 && Date.now() - hiddenAt >= idleMs)) {
      onResume();
    }
    hiddenAt = 0;
  };

  document.addEventListener('visibilitychange', maybeResume);
  window.addEventListener('pageshow', onPageShow);

  return () => {
    document.removeEventListener('visibilitychange', maybeResume);
    window.removeEventListener('pageshow', onPageShow);
  };
}

/** One automatic reload after a long idle so a stuck in-flight fetch is abandoned. */
export function consumeIdleResumeReload(): boolean {
  try {
    if (sessionStorage.getItem(RESUME_RELOAD_GUARD)) {
      return false;
    }
    sessionStorage.setItem(RESUME_RELOAD_GUARD, '1');
    return true;
  } catch {
    return false;
  }
}

export function clearIdleResumeReloadGuard(): void {
  try {
    sessionStorage.removeItem(RESUME_RELOAD_GUARD);
  } catch {
    // ignore
  }
}
