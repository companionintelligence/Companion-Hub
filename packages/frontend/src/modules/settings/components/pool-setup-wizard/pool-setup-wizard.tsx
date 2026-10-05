import { poolStatusQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import { useTailscaleBrowserAuth } from '@/lib/hooks/use-tailscale-browser-auth';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApproveStep } from './approve-step';
import { ConnectStep } from './connect-step';
import { FindStep } from './find-step';
import { usePairingBatch, usePoolSetupMutations, usePoolStatusLive, useTailscaleReadiness } from './pool-setup-hooks';
import { type SetupStep, assessReadiness, chooseInitialStep } from './pool-setup-model';
import { PoolSetupStepper } from './pool-setup-stepper';
import { ReadyStep } from './ready-step';

interface PoolSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where to begin when asked to ADD a Hub rather than resume one: the live peers would otherwise send the guide to Approve. */
  startAt?: 'find';
}

/**
 * "Set up your Hub Pool": check this Hub, find the others, send requests, then approve and verify.
 *
 * Every piece of state that matters lives on the server, not here. The step is derived from pool
 * status each time the dialog opens, so closing it loses nothing and reopening it can never replay a
 * send. Load it through `LazyPoolSetupWizard`, which renders it only while open.
 */
export function PoolSetupWizard({ open, onOpenChange, startAt }: PoolSetupWizardProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wider than the stock "xl" on desktop so Hubs sit in two columns. On a phone it is the whole screen: a floating card with a
          gutter on each side leaves too little room for a Hub's name, chips and a 44px button. */}
      <DialogContent
        size="xl"
        className="gap-4 overflow-y-auto pb-0 sm:max-h-[calc(100dvh-3rem)] sm:max-w-2xl sm:pb-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:grid-rows-[auto_1fr] max-sm:max-h-none max-sm:w-screen max-sm:max-w-none! max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
        data-testid="pool-setup-wizard"
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle>{t('HUB_POOL_SETUP_TITLE')}</DialogTitle>
          <DialogDescription>{t('HUB_POOL_SETUP_DESCRIPTION')}</DialogDescription>
        </DialogHeader>
        <PoolSetupWizardBody onDone={() => onOpenChange(false)} startAt={startAt} />
      </DialogContent>
    </Dialog>
  );
}

function PoolSetupWizardBody({ onDone, startAt }: { onDone: () => void; startAt?: 'find' }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const demoMode = useDemoMode();

  // `null` until there is enough to choose a step. Never persisted: see the note on the component.
  const [step, setStep] = useState<SetupStep | null>(null);
  const [signInStarted, setSignInStarted] = useState(false);
  // Only a press of Check again shows as busy. The readiness poll fetches every few seconds, and a button
  // that disabled itself on each poll would drop keyboard focus.
  const [rechecking, setRechecking] = useState(false);

  const live = usePoolStatusLive(step);
  const poolQuery = live.query;
  const tailscaleQuery = useTailscaleReadiness(step);
  const batch = usePairingBatch();
  const mutations = usePoolSetupMutations();
  const tailscaleAuth = useTailscaleBrowserAuth({ onBrowserOpened: () => setSignInStarted(true) });

  const pool = poolQuery.data;
  const tailscaleLoading = tailscaleQuery.isPending;

  const readiness = useMemo(() => (pool ? assessReadiness({ ts: tailscaleQuery.data, pool }) : undefined), [pool, tailscaleQuery.data]);

  useEffect(() => {
    // Wait out the refetch the open itself triggers: a cached status can be older than a request made elsewhere.
    if (step !== null || !pool || poolQuery.isFetching) return;
    // A Hub with any peer row resolves at once, without waiting for the slower Tailscale read. Not when the user pressed
    // "add a Hub": then the existing peers are not the point, and the first screen should be the scan.
    if (pool.peers.length > 0 && startAt !== 'find') {
      setStep('approve');
      return;
    }
    if (tailscaleLoading || !readiness) return;
    setStep(chooseInitialStep({ peerCount: 0, readiness }));
  }, [step, pool, poolQuery.isFetching, tailscaleLoading, readiness, startAt]);

  // The host (Home card, Settings panel) shows pool state too; refresh it as the guide goes away.
  useEffect(
    () => () => {
      void queryClient.invalidateQueries({ queryKey: poolStatusQueryKey() });
    },
    [queryClient],
  );

  // Move focus to the new step's heading so a keyboard or screen reader user lands where the content changed.
  const contentRef = useRef<HTMLDivElement>(null);
  const previousStep = useRef<SetupStep | null>(null);
  useEffect(() => {
    if (previousStep.current !== null && step !== null && previousStep.current !== step) {
      contentRef.current?.querySelector<HTMLElement>('[data-step-heading]')?.focus();
    }
    previousStep.current = step;
  }, [step]);

  if (poolQuery.isError && !pool) {
    return (
      <div className="space-y-3" data-testid="pool-setup-load-error">
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          {t('HUB_POOL_SETUP_LOAD_ERROR')}
        </p>
        <Button type="button" size="sm" variant="outline" loading={poolQuery.isFetching} onClick={() => void poolQuery.refetch()}>
          {t('COMMON_RETRY')}
        </Button>
      </div>
    );
  }

  if (step === null || !pool || !readiness) {
    return (
      <div role="status" data-testid="pool-setup-loading" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
        <span>{t('HUB_POOL_SETUP_LOADING')}</span>
      </div>
    );
  }

  const approvingId = mutations.approve.isPending ? (mutations.approve.variables ?? null) : null;
  const rejectingId = mutations.reject.isPending ? (mutations.reject.variables ?? null) : null;
  const cancellingId = mutations.cancel.isPending ? (mutations.cancel.variables ?? null) : null;
  const unpairingId = mutations.unpair.isPending ? (mutations.unpair.variables ?? null) : null;

  return (
    <div className="flex min-h-0 flex-col gap-4" ref={contentRef}>
      <PoolSetupStepper step={step} />

      {step === 'ready' && tailscaleLoading ? (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
          <span>{t('HUB_POOL_SETUP_LOADING')}</span>
        </div>
      ) : null}

      {step === 'ready' && !tailscaleLoading ? (
        <ReadyStep
          readiness={readiness}
          signInStarted={signInStarted}
          signInPending={tailscaleAuth.isPending}
          poolingPending={mutations.enablePooling.isPending}
          checking={rechecking}
          demoMode={demoMode}
          onTurnOnPooling={() => mutations.enablePooling.mutate()}
          onConnectTailscale={() => tailscaleAuth.mutate()}
          onCheckAgain={() => {
            setRechecking(true);
            void Promise.all([tailscaleQuery.refetch(), poolQuery.refetch()]).finally(() => setRechecking(false));
          }}
          onContinue={() => setStep('find')}
        />
      ) : null}

      {step === 'find' ? (
        <FindStep
          pool={pool}
          ts={tailscaleQuery.data}
          readiness={tailscaleLoading ? undefined : readiness}
          demoMode={demoMode}
          onBack={() => setStep('ready')}
          onSend={(targets, pin) => {
            setStep('connect');
            void batch.send(targets, pin);
          }}
          onReview={() => setStep('approve')}
          onCheckReadiness={() => setStep('ready')}
        />
      ) : null}

      {step === 'connect' ? (
        <ConnectStep
          rows={batch.currentRows}
          sending={batch.sending}
          demoMode={demoMode}
          onBack={() => setStep('find')}
          onContinue={() => setStep('approve')}
          onRetry={(row) => void batch.retry(row.nodeFqdn, row.hostname)}
          onRetryFailed={() => void batch.retryFailed()}
        />
      ) : null}

      {step === 'approve' ? (
        <ApproveStep
          pool={pool}
          dataUpdateCount={live.dataUpdateCount}
          sentRows={batch.sentRows}
          cancelled={batch.cancelled}
          settledAfterUpdate={batch.settledAfterUpdate}
          longWait={live.longWait}
          expired={live.expired}
          demoMode={demoMode}
          approvingId={approvingId}
          rejectingId={rejectingId}
          cancellingId={cancellingId}
          unpairingId={unpairingId}
          onApprove={(id) => mutations.approve.mutate(id)}
          onReject={(id) => mutations.reject.mutate(id)}
          onCancel={(peer) => {
            batch.markCancelled(peer.nodeFqdn);
            mutations.cancel.mutate(peer.id);
          }}
          onUnpair={(peer) => {
            // Removed here on purpose, so its disappearance is not reported as a request that vanished.
            batch.markCancelled(peer.nodeFqdn);
            mutations.unpair.mutate(peer.id);
          }}
          onCheckAgain={() => {
            live.resume();
            void poolQuery.refetch();
          }}
          onFind={() => setStep('find')}
          onPairAgain={(row) => {
            setStep('connect');
            void batch.retry(row.nodeFqdn, row.hostname);
          }}
          onDone={onDone}
        />
      ) : null}
    </div>
  );
}
