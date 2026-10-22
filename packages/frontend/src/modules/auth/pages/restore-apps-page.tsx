import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { acknowledgeRestore, executeRehydrate, getRehydrateStatus } from '@/api-client/sdk.gen';
import { sdkResult } from '@/lib/sdk-unwrap';
import { clearStoredDriftChoice, getStoredDriftChoice } from '@/lib/registration-state-drift';
import { QueuedInstallsIndicator } from '@/modules/dashboard/components/queued-installs-indicator';
import { useInstallQueue } from '@/modules/app/helpers/use-install-queue';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { RestoreSummary } from '../components/restore-summary';
import {
  describeRestoreFailure,
  rememberRestoreSeen,
  summaryIsSettling,
  type RestoreStatus,
  type RestoreSummary as RestoreSummaryData,
} from '../helpers/restore-status';

/** How often the page reads the Hub's restore status while it waits on the Hub. */
const STATUS_POLL_MS = 2_000;
/** How long the apps check may take before the page offers to go on to setup without it. */
const CHECKING_SLOW_MS = 20_000;

interface RehydrationPlanItem {
  portalApp: { name: string; slug: string };
  action: string;
  reason?: string;
  hasExistingData: boolean;
}

interface RehydrationPlan {
  items: RehydrationPlanItem[];
  portalAppCount: number;
}

interface RehydrationExecuteResult {
  success: boolean;
  message: string;
  alreadyCompleted?: boolean;
  /** An install was refused for this account, so the restore was not recorded as done. */
  incomplete?: boolean;
  plan: RehydrationPlan;
  queued: string[];
  started: string[];
  skipped: Array<{ name: string; reason: string; code?: RestoreSkipCode; params?: Record<string, string> }>;
}

type RestoreSkipCode = NonNullable<RestoreSummaryData['notRestored'][number]['code']>;

function RestoreAppsContent() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { refreshAppContext } = useAppContext();
  const [plan, setPlan] = useState<RehydrationPlan | null>(null);
  const [result, setResult] = useState<RehydrationExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [summary, setSummary] = useState<RestoreSummaryData | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkingSlow, setCheckingSlow] = useState(false);
  const startedRef = useRef(false);
  const { data: installQueue, isLoading: isQueueLoading } = useInstallQueue();

  const readStatus = useCallback(async (): Promise<RestoreStatus> => {
    const statusResult = await sdkResult(getRehydrateStatus());
    if (!statusResult.ok || !statusResult.data) {
      throw new Error(t('RESTORE_APPS_STATUS_FAILED'));
    }
    return statusResult.data;
  }, [t]);

  /**
   * Leaves for the Hub. The restore is recorded as seen first, or the next sign-in, from this browser or
   * any other, would be sent back here; the restore choice is dropped for the same reason. `seen` is the
   * summary the person is leaving, when there is one.
   */
  const leaveForHub = useCallback(
    async (to = '/home', seen?: RestoreSummaryData) => {
      clearStoredDriftChoice();
      let recorded = false;
      try {
        recorded = (await sdkResult(acknowledgeRestore())).ok;
      } catch {
        // Recorded stays false.
      }
      if (!recorded) {
        // Someone who may not manage the Hub cannot acknowledge it, though nor was the notice holding
        // them here. For anyone else this keeps an unrecorded Continue from bouncing straight back.
        rememberRestoreSeen(seen);
      }
      await refreshAppContext();
      navigate(to, { replace: true });
    },
    [navigate, refreshAppContext],
  );

  /** Shows the finished restore's summary when the Hub has one for this person. True when it did. */
  const showSummaryIfReady = useCallback(async (): Promise<boolean> => {
    try {
      const status = await readStatus();
      if (status.noticePending && status.summary) {
        setSummary(status.summary);
        return true;
      }
    } catch {
      // Carry on as the page did without a summary.
    }
    return false;
  }, [readStatus]);

  const runRehydrate = useCallback(async () => {
    const executeResult = await sdkResult(executeRehydrate({ body: { source: 'restore' } } as Parameters<typeof executeRehydrate>[0]));
    const data = executeResult.data as (RehydrationExecuteResult & { message?: string }) | undefined;
    if (!data) {
      throw new Error(t('RESTORE_APPS_EXECUTE_FAILED'));
    }

    if (!executeResult.ok || !data.success) {
      throw new Error(data.message ?? t('RESTORE_APPS_EXECUTE_FAILED'));
    }

    setPlan(data.plan);
    setResult(data);

    // A refused install keeps the page: moving on would hide which apps were not restored, and why.
    if (data.incomplete) {
      return;
    }

    // The run is done, so the Hub can say what came back and what did not, which is what a person who
    // signs in after a restore is here to see. Moving on before that hid an app that failed.
    if (await showSummaryIfReady()) {
      return;
    }

    if (data.alreadyCompleted || ((data.queued?.length ?? 0) === 0 && (data.started?.length ?? 0) === 0)) {
      // A finished restore reports its plan only for show, so an empty one says nothing about the account.
      if (!data.alreadyCompleted && (data.plan?.portalAppCount ?? 0) === 0) {
        toast.success(t('RESTORE_APPS_EMPTY_PORTAL'));
      }
      await leaveForHub();
    }
  }, [leaveForHub, showSummaryIfReady, t]);

  const showFailure = useCallback(
    (failure: unknown) => {
      const message = failure instanceof Error ? failure.message : t('RESTORE_APPS_EXECUTE_FAILED');
      setError(message);
      toast.error(message);
    },
    [t],
  );

  const restore = useCallback(async () => {
    setIsExecuting(true);
    try {
      await runRehydrate();
    } catch (executeError) {
      showFailure(executeError);
    } finally {
      setIsExecuting(false);
    }
  }, [runRehydrate, showFailure]);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    (async () => {
      let status: RestoreStatus;
      try {
        status = await readStatus();
      } catch (statusError) {
        showFailure(statusError);
        return;
      }

      // The Hub restored on its own after pairing and nobody who manages it has seen what came back.
      if (status.noticePending && status.summary) {
        setSummary(status.summary);
        return;
      }

      // Paired a moment ago: whether there is anything to restore is not known yet.
      if (status.checking && !status.noticePending) {
        setChecking(true);
        return;
      }

      if (status.completed) {
        // The Hub restores on its own after pairing, often before this page opens. Asking anyway
        // finishes the restore for this person, who would otherwise be sent on to onboarding.
        try {
          await runRehydrate();
        } catch {
          await leaveForHub();
        }
        return;
      }

      await restore();
    })();
  }, [leaveForHub, readStatus, restore, runRehydrate, showFailure]);

  // Waits on the apps check. A restore that begins is shown here. A pairing with nothing to restore
  // goes on to the Hub, which opens setup.
  useEffect(() => {
    if (!checking) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const poll = async () => {
      if (Date.now() - startedAt >= CHECKING_SLOW_MS) {
        setCheckingSlow(true);
      }
      try {
        const status = await readStatus();
        if (cancelled) {
          return;
        }
        if (status.noticePending) {
          setChecking(false);
          if (status.summary) {
            setSummary(status.summary);
          } else {
            await restore();
          }
          return;
        }
        if (!status.checking) {
          setChecking(false);
          navigate('/home', { replace: true });
          return;
        }
      } catch {
        // Ask again on the next pass.
      }
      if (!cancelled) {
        timer = setTimeout(() => void poll(), STATUS_POLL_MS);
      }
    };

    timer = setTimeout(() => void poll(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [checking, navigate, readStatus, restore]);

  // A summary with apps still installing is read again, so each one shows when it is up or has failed.
  useEffect(() => {
    if (!summaryIsSettling(summary)) {
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const status = await readStatus();
          if (status.summary) {
            setSummary(status.summary);
          }
        } catch {
          // Keep what is shown; the next change of summary asks again.
        }
      })();
    }, STATUS_POLL_MS);
    return () => clearTimeout(timer);
  }, [readStatus, summary]);

  const retry = async () => {
    setError(null);
    await restore();
  };

  useEffect(() => {
    if (!result || result.alreadyCompleted || result.incomplete || summary) {
      return;
    }

    const waiting = installQueue?.queued?.length ?? 0;
    const active = installQueue?.active;
    if (!active && waiting === 0 && !isQueueLoading) {
      void (async () => {
        if (await showSummaryIfReady()) {
          return;
        }
        await leaveForHub();
      })();
    }
  }, [installQueue, isQueueLoading, leaveForHub, result, showSummaryIfReady, summary]);

  if (summary) {
    return (
      <div
        className="flex flex-col items-center overflow-y-auto px-4 py-8"
        style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}
        data-testid="restore-apps-page"
      >
        <RestoreSummary summary={summary} onLeave={(to) => void leaveForHub(to, summary)} />
      </div>
    );
  }

  if (checking) {
    return (
      <div
        className="flex flex-col items-center overflow-y-auto px-4 py-8"
        style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}
        data-testid="restore-apps-page"
      >
        <div className="w-full max-w-2xl space-y-4">
          <h1 className="text-2xl font-semibold text-foreground">{t('RESTORE_APPS_CHECKING_TITLE')}</h1>
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden />
            <span>{t('RESTORE_APPS_CHECKING')}</span>
          </div>
          {checkingSlow ? (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>{t('RESTORE_APPS_CHECKING_SLOW')}</p>
              <Button
                intent="secondary"
                onClick={() => {
                  // Kept, the tab's restore choice sent it back here from Home once setup was done.
                  clearStoredDriftChoice();
                  navigate('/onboarding', { replace: true });
                }}
              >
                {t('RESTORE_APPS_CONTINUE_TO_SETUP')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const skipped = result?.skipped ?? [];
  const actionableCount = plan?.items.filter((item) => item.action === 'install' || item.action === 'start').length ?? 0;

  return (
    <div
      className="flex flex-col items-center overflow-y-auto px-4 py-8"
      style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}
      data-testid="restore-apps-page"
    >
      <div className="w-full max-w-2xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t('RESTORE_APPS_TITLE')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('RESTORE_APPS_DESCRIPTION')}</p>
        </div>

        {error ? (
          <Alert variant="danger">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {!isExecuting && error && !result?.incomplete ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button intent="secondary" onClick={() => void retry()}>
              {t('COMMON_RETRY')}
            </Button>
            <Button intent="primary" onClick={() => void leaveForHub()}>
              {t('RESTORE_APPS_CONTINUE_IN_BACKGROUND')}
            </Button>
          </div>
        ) : null}

        {isExecuting ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden />
            <span>{t('RESTORE_APPS_EXECUTING')}</span>
          </div>
        ) : null}

        <QueuedInstallsIndicator queue={installQueue} isLoading={isQueueLoading} />

        {plan ? (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">
              {t('RESTORE_APPS_PLAN_SUMMARY', { count: plan.portalAppCount, actionable: actionableCount })}
            </p>
            <ul className="mt-3 space-y-2">
              {plan.items.map((item) => (
                <li key={item.portalApp.slug} className="flex items-start justify-between gap-3 text-sm">
                  <div>
                    <p className="font-medium text-foreground">{item.portalApp.name}</p>
                    <p className="text-xs text-muted-foreground">{t(`RESTORE_APPS_ACTION_${item.action.toUpperCase()}`)}</p>
                    {item.hasExistingData ? <p className="text-xs text-success">{t('RESTORE_APPS_REUSING_DATA')}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {skipped.length > 0 ? (
          <Alert>
            <AlertDescription>
              <p className="font-medium">{t('RESTORE_APPS_PARTIAL_SKIP_TITLE')}</p>
              <ul className="mt-2 list-disc pl-5 text-sm">
                {skipped.map((entry) => (
                  <li key={`${entry.name}-${entry.reason}`}>
                    {entry.name}: {describeRestoreFailure(t, (key) => i18n.exists(key), entry)}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {!isExecuting && result?.incomplete ? (
          <Alert variant="warning">
            <AlertDescription>
              <p className="font-medium">{t('RESTORE_APPS_INCOMPLETE_TITLE')}</p>
              <p className="mt-1 text-sm">{t('RESTORE_APPS_INCOMPLETE_DESCRIPTION')}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Button intent="secondary" onClick={() => void retry()}>
                  {t('COMMON_RETRY')}
                </Button>
                <Button intent="primary" onClick={() => void leaveForHub()}>
                  {t('RESTORE_APPS_CONTINUE_IN_BACKGROUND')}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {!isExecuting && result && !result.incomplete && (installQueue?.queued?.length ?? 0) > 0 ? (
          <Button intent="primary" className="w-full" onClick={() => void leaveForHub()}>
            {t('RESTORE_APPS_CONTINUE_IN_BACKGROUND')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RestoreAppsGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (getStoredDriftChoice() === 'restore') {
        if (!cancelled) {
          setAllowed(true);
        }
        return;
      }

      try {
        const statusResult = await sdkResult(getRehydrateStatus());
        if (!statusResult.ok) {
          if (!cancelled) {
            setAllowed(false);
          }
          return;
        }

        const status = statusResult.data;
        if (!cancelled) {
          setAllowed(Boolean(status && (status.noticePending || status.checking || (status.restoreIntent && !status.completed))));
        }
      } catch {
        if (!cancelled) {
          setAllowed(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (allowed === null) {
    return (
      <div className="flex items-center justify-center bg-background" style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}>
        <div
          className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"
          role="status"
          aria-label={t('COMMON_LOADING')}
        />
      </div>
    );
  }

  if (!allowed) {
    return <Navigate to="/home" replace />;
  }

  return children;
}

export default function RestoreAppsPage() {
  const { isLoggedIn } = useUserContext();

  if (!isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center bg-background" style={{ minHeight: 'calc(100vh - var(--titlebar-height, 0px))' }}>
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" role="status" />
        </div>
      }
    >
      <RestoreAppsGate>
        <AppContextProvider>
          <RestoreAppsContent />
        </AppContextProvider>
      </RestoreAppsGate>
    </Suspense>
  );
}
