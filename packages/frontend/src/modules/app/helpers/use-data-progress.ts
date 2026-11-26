import type { DataProgress } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { useEffect, useState } from 'react';

// How far each running backup or restore has got, as the Hub last reported it. A page opened in the
// middle of one gets the latest figure replayed when its event stream connects.
const progressByApp = new Map<string, DataProgress>();
const subscribers = new Set<(appUrn: string, progress: DataProgress | null) => void>();

/** Record a backup or restore's progress (`null` once no such step is under way). Called by the SSE handler. */
export const setDataProgress = (appUrn: AppUrn, progress: DataProgress | null) => {
  if (progress === null) {
    if (!progressByApp.delete(appUrn)) return;
  } else {
    progressByApp.set(appUrn, progress);
  }

  for (const notify of subscribers) {
    notify(appUrn, progress);
  }
};

/** The step and figures of the backup or restore of `appUrn`, or `null` when none was reported. */
export const useDataProgress = (appUrn?: AppUrn): DataProgress | null => {
  const [progress, setProgress] = useState<DataProgress | null>(null);

  useEffect(() => {
    if (!appUrn) {
      setProgress(null);
      return;
    }

    setProgress(progressByApp.get(appUrn) ?? null);

    const onChange = (changedUrn: string, next: DataProgress | null) => {
      if (changedUrn === appUrn) {
        setProgress(next);
      }
    };

    subscribers.add(onChange);
    return () => {
      subscribers.delete(onChange);
    };
  }, [appUrn]);

  return progress;
};
