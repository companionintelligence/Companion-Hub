import { useAppContext } from '@/context/app-context';

/** True when the Hub runs in demo mode (mutating actions should be disabled). */
export function useDemoMode(): boolean {
  const { userSettings } = useAppContext();
  return Boolean(userSettings?.demoMode);
}
