import type { AppUrn } from '@ci-hub/common/types';
import { useState, useEffect } from 'react';

// Global progress map to track installation progress across components
// This allows multiple components to share the same progress data
const installationProgressMap = new Map<string, number>();

// Subscribers to progress updates
const progressSubscribers = new Set<(appUrn: string, progress: number | null) => void>();

/**
 * Update installation progress for an app
 * This is called by the SSE provider when it receives progress updates
 */
export const updateInstallationProgress = (appUrn: AppUrn, progress: number | null) => {
  if (progress === null) {
    installationProgressMap.delete(appUrn);
  } else {
    installationProgressMap.set(appUrn, progress);
  }

  // Notify all subscribers
  progressSubscribers.forEach((callback) => {
    callback(appUrn, progress);
  });
};

export const useInstallationProgress = (appUrn?: AppUrn) => {
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (!appUrn) {
      setProgress(null);
      return;
    }

    // Initialize progress from map if available
    const existingProgress = installationProgressMap.get(appUrn);
    if (existingProgress !== undefined) {
      setProgress(existingProgress);
    }

    // Subscribe to progress updates
    const updateProgress = (eventAppUrn: string, newProgress: number | null) => {
      if (eventAppUrn === appUrn) {
        setProgress(newProgress);
      }
    };

    progressSubscribers.add(updateProgress);

    return () => {
      progressSubscribers.delete(updateProgress);
    };
  }, [appUrn]);

  return progress;
};
