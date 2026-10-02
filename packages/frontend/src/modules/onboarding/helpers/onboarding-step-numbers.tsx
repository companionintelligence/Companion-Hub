import { createContext, useContext } from 'react';

/**
 * Step number for Recommended Apps. The AI step provides it so a machine that
 * skips local models does not leave a gap in the numbering.
 */
export const OnboardingAppsStepContext = createContext(6);

export function useOnboardingAppsStep(): number {
  return useContext(OnboardingAppsStepContext);
}
