import { AppContextProvider, useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { apiFetch } from '@/lib/api-fetch';
import { clearStoredDriftChoice, getStoredDriftChoice } from '@/lib/registration-state-drift';
import { QueuedInstallsIndicator } from '@/modules/dashboard/components/queued-installs-indicator';
import { useInstallQueue } from '@/modules/app/helpers/use-install-queue';
import { Suspense, useEffect, useRef, useState } from 'react';
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
  plan: RehydrationPlan;
  queued: string[];
  started: string[];
  skipped: Array<{ name: string; reason: string }>;
}

interface RehydrationStatus {
  completed: boolean;
  restoreIntent: boolean;
}

async function readApiJson<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
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
  const { data: installQueue, isLoading: isQueueLoading } = useInstallQueue(true);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    (async () => {
      try {
        const statusRes = await apiFetch('/api/app-lifecycle/rehydrate/status');
        if (!statusRes.ok) {
          throw new Error(t('RESTORE_APPS_STATUS_FAILED'));
        }

        const status = await readApiJson<RehydrationStatus>(statusRes);
        if (!status) {
          throw new Error(t('RESTORE_APPS_STATUS_FAILED'));
        }
        if (status.completed) {
          clearStoredDriftChoice();
          await refreshAppContext();
          navigate('/home', { replace: true });
          return;
        }

        setIsExecuting(true);
        const res = await apiFetch('/api/app-lifecycle/rehydrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'restore' }),
        });
        const data = await readApiJson<RehydrationExecuteResult & { message?: string }>(res);
        if (!data) {
          throw new Error(t('RESTORE_APPS_EXECUTE_FAILED'));
        }

        if (!res.ok || !data.success) {
          throw new Error(data.message ?? t('RESTORE_APPS_EXECUTE_FAILED'));
        }

        setPlan(data.plan);
        setResult(data);

        if (data.alreadyCompleted || ((data.queued?.length ?? 0) === 0 && (data.started?.length ?? 0) === 0)) {
          clearStoredDriftChoice();
          await refreshAppContext();
          if ((data.plan?.portalAppCount ?? 0) === 0) {
            toast.success(t('RESTORE_APPS_EMPTY_PORTAL'));
          }
          navigate('/home', { replace: true });
        }
      } catch (executeError) {
        const message = executeError instanceof Error ? executeError.message : t('RESTORE_APPS_EXECUTE_FAILED');
        setError(message);
        toast.error(message);
      } finally {
        setIsExecuting(false);
      }
    })();
  }, [navigate, refreshAppContext, t]);

  useEffect(() => {
    if (!result || result.alreadyCompleted) {
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
                    {item.hasExistingData ? <p className="text-xs text-emerald-600">{t('RESTORE_APPS_REUSING_DATA')}</p> : null}
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
                    {entry.name}: {entry.reason}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {!isExecuting && result && (installQueue?.queued?.length ?? 0) > 0 ? (
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
        const res = await apiFetch('/api/app-lifecycle/rehydrate/status');
        if (!res.ok) {
          if (!cancelled) {
            setAllowed(false);
          }
          return;
        }

        const status = await readApiJson<{ restoreIntent?: boolean; completed?: boolean }>(res);
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
