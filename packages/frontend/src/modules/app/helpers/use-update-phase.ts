import type { UpdatePhase } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { useEffect, useState } from 'react';

// The step each running update is in, as the Hub last reported it. A page opened mid-update gets the
// latest step replayed when its event stream connects, so this is filled before the next step.
const updatePhases = new Map<string, UpdatePhase>();
const subscribers = new Set<(appUrn: string, phase: UpdatePhase | null) => void>();

/** Record an update's step (`null` once the update has ended). Called by the SSE handler. */
export const setUpdatePhase = (appUrn: AppUrn, phase: UpdatePhase | null) => {
  if (phase === null) {
    updatePhases.delete(appUrn);
  } else {
    updatePhases.set(appUrn, phase);
  }

  for (const notify of subscribers) {
    notify(appUrn, phase);
  }
};

/** The step the update of `appUrn` is in, or `null` when none was reported. */
export const useUpdatePhase = (appUrn?: AppUrn): UpdatePhase | null => {
  const [phase, setPhase] = useState<UpdatePhase | null>(null);

  useEffect(() => {
    if (!appUrn) {
      setPhase(null);
      return;
    }

    setPhase(updatePhases.get(appUrn) ?? null);

    const onChange = (changedUrn: string, next: UpdatePhase | null) => {
      if (changedUrn === appUrn) {
        setPhase(next);
      }
    };

    subscribers.add(onChange);
    return () => {
      subscribers.delete(onChange);
    };
  }, [appUrn]);

  return phase;
};
