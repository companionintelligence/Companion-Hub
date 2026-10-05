import { Suspense, lazy } from 'react';

const PoolSetupWizard = lazy(() => import('./pool-setup-wizard').then((module) => ({ default: module.PoolSetupWizard })));

interface LazyPoolSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `'find'` for a host whose button says "add a Hub": skip resuming on Approve and go straight to scanning. */
  startAt?: 'find';
}

/**
 * Loads the guide only when it is opened, and renders nothing while closed.
 *
 * Three hosts mount it (Home, Settings, first-run setup). Keeping it out of their bundles keeps the
 * Home page's chunk small, and keeping it unmounted while closed guarantees that no query, timer or
 * scan runs for a guide nobody opened. Each host renders this OUTSIDE its own visibility gating: the
 * Home card hides itself the moment the first request exists, and an unmounted guide would vanish
 * mid-flow.
 */
export function LazyPoolSetupWizard({ open, onOpenChange, startAt }: LazyPoolSetupWizardProps) {
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <PoolSetupWizard open={open} onOpenChange={onOpenChange} startAt={startAt} />
    </Suspense>
  );
}
