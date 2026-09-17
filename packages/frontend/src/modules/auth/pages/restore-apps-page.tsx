import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { executeRehydrate, getRehydrateStatus } from '@/api-client/sdk.gen';
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
import toast from 'react-hot-toast';

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
  skipped: Array<{ name: string; reason: string }>;
}

interface RehydrationStatus {
  completed: boolean;
  restoreIntent: boolean;
}

function RestoreAppsContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { refreshAppContext } = useAppContext();
  const [plan, setPlan] = useState<RehydrationPlan | null>(null);
  const [result, setResult] = useState<RehydrationExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const startedRef = useRef(false);
  const { data: installQueue, isLoading: isQueueLoading } = useInstallQueue();

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
    if (!data.incomplete && (data.alreadyCompleted || ((data.queued?.length ?? 0) === 0 && (data.started?.length ?? 0) === 0))) {
      clearStoredDriftChoice();
      await refreshAppContext();
      // A finished restore reports its plan only for show, so an empty one says nothing about the account.
      if (!data.alreadyCompleted && (data.plan?.portalAppCount ?? 0) === 0) {
        toast.success(t('RESTORE_APPS_EMPTY_PORTAL'));
      }
      navigate('/home', { replace: true });
    }
  }, [navigate, refreshAppContext, t]);

  const showFailure = useCallback(
    (failure: unknown) => {
      const message = failure instanceof Error ? failure.message : t('RESTORE_APPS_EXECUTE_FAILED');
      setError(message);
      toast.error(message);
    },
    [t],
  );

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    (async () => {
      try {
        const statusResult = await sdkResult(getRehydrateStatus());
        if (!statusResult.ok) {
          throw new Error(t('RESTORE_APPS_STATUS_FAILED'));
        }

        const status = statusResult.data as RehydrationStatus | null;
        if (!status) {
          throw new Error(t('RESTORE_APPS_STATUS_FAILED'));
        }
        if (status.completed) {
          // The Hub restores on its own after pairing, often before this page opens. Asking anyway
          // finishes the restore for this person, who would otherwise be sent on to onboarding.
          try {
            await runRehydrate();
          } catch {
            clearStoredDriftChoice();
            await refreshAppContext();
            navigate('/home', { replace: true });
          }
          return;
        }

        setIsExecuting(true);
        await runRehydrate();
      } catch (executeError) {
        showFailure(executeError);
      } finally {
        setIsExecuting(false);
      }
    })();
  }, [navigate, refreshAppContext, runRehydrate, showFailure, t]);

  const retry = async () => {
    setError(null);
    setIsExecuting(true);
    try {
      await runRehydrate();
    } catch (retryError) {
      showFailure(retryError);
    } finally {
      setIsExecuting(false);
    }
  };

  // Drops the restore choice first: the dashboard would otherwise send this session straight back here.
  const continueToDashboard = async () => {
    clearStoredDriftChoice();
    await refreshAppContext();
    navigate('/home', { replace: true });
  };

  useEffect(() => {
    if (!result || result.alreadyCompleted || result.incomplete) {
      return;
    }

    const waiting = installQueue?.queued?.length ?? 0;
    const active = installQueue?.active;
    if (!active && waiting === 0 && !isQueueLoading) {
      clearStoredDriftChoice();
      void refreshAppContext().then(() => navigate('/home', { replace: true }));
    }
  }, [installQueue, isQueueLoading, navigate, refreshAppContext, result]);

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
                    {entry.name}: {entry.reason === 'APP_ACTION_GRANT_DENIED' ? t('APP_ACTION_GRANT_DENIED', { action: 'install' }) : entry.reason}
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
                <Button intent="primary" onClick={() => void continueToDashboard()}>
                  {t('RESTORE_APPS_CONTINUE_IN_BACKGROUND')}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {!isExecuting && result && !result.incomplete && (installQueue?.queued?.length ?? 0) > 0 ? (
          <Button intent="primary" className="w-full" onClick={() => navigate('/home')}>
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

        const status = statusResult.data as { restoreIntent?: boolean; completed?: boolean } | undefined;
        if (!cancelled) {
          setAllowed(Boolean(status?.restoreIntent) && !status?.completed);
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
