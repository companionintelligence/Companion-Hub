import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { relayNavigation } from '@/lib/navigation-relay';
import { useEffect, useRef } from 'react';

/** The parameters each step's API request takes, read from this page's own query. */
const STEP_PARAMS = {
  start: ['app', 'next'],
  callback: ['code', 'state', 'error'],
} as const;

/**
 * Carries on a Connect Memory navigation: `GET /api/memory-connect/start` (the launcher's link) and
 * `GET /api/memory-connect/callback` (ci-memory's consent returning) hand the browser here, and this
 * page makes the step's request with its own session token. The Hub's cookie is no credential; see
 * `relayNavigation`. A step that cannot go on lands on the Hub with a marker, as before.
 */
export default function MemoryConnectContinuePage() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;

    const query = new URLSearchParams(window.location.search);
    const step = query.get('step');
    if (step !== 'start' && step !== 'callback') {
      window.location.replace('/?memoryConnect=error');
      return;
    }

    const body: Record<string, string> = {};
    for (const key of STEP_PARAMS[step]) {
      const value = query.get(key);
      if (value) {
        body[key] = value;
      }
    }

    void relayNavigation(`/api/memory-connect/${step}`, body).then((outcome) => {
      if (outcome.kind === 'refused') {
        window.location.replace(step === 'start' ? '/?memoryConnect=unavailable' : '/?memoryConnect=error');
      }
    });
  }, []);

  return <PageLoadingSpinner />;
}
