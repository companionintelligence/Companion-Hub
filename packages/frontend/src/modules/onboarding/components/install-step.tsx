import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getInstalledAppsQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { OnboardingApp } from '../helpers/types';

interface InstallStepProps {
  apps: OnboardingApp[];
  onComplete: () => void;
}

type InstallStatus = 'pending' | 'installing' | 'success' | 'error';

interface AppInstallState {
  app: OnboardingApp;
  status: InstallStatus;
  error?: string;
}

export const InstallStep = ({ apps, onComplete }: InstallStepProps) => {
  const [states, setStates] = useState<AppInstallState[]>(apps.map((app) => ({ app, status: 'pending' })));
  const [done, setDone] = useState(false);
  const started = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const queryClient = useQueryClient();

  // biome-ignore lint/correctness/useExhaustiveDependencies: queryClient is stable from useQueryClient
  useEffect(() => {
    if (started.current || apps.length === 0) return;
    started.current = true;

    const installAll = async () => {
      const minDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

      for (let i = 0; i < apps.length; i++) {
        const app = apps[i];
        if (!app) continue;

        if (!app.urn) {
          setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'error', error: 'Not available in store' } : s)));
          await minDelay(500);
          continue;
        }

        setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'installing' } : s)));
        // Add an optimistic entry to the installed apps cache so the dashboard
        // and other pages show the app as "installing" while the server
        // processes the request.
        try {
          const installedKey = getInstalledAppsQueryKey();
          const existing = (queryClient.getQueryData(installedKey) as { installed: Record<string, Record<string, unknown>>[] }) || { installed: [] };
          // Remove any prior optimistic entry for this urn
          const filtered = existing.installed.filter((it) => it.info?.urn !== app.urn);
          const tempId = `pending-${app.appSlug}-${Date.now()}`;
          const optimistic = {
            info: {
              urn: app.urn,
              id: app.appSlug,
              name: app.name,
              available: true,
            },
            app: {
              id: tempId,
              status: 'installing',
            },
            metadata: { latestVersion: 0, localSubdomain: app.localSubdomain || '' },
          };
          queryClient.setQueryData(installedKey, { installed: [optimistic, ...filtered] });
        } catch (_e) {
          // Non-fatal; proceed without optimistic cache if something fails
          // (e.g., no query client available)
          // console.warn('Failed to set optimistic installed app', e);
        }

        try {
          // Trigger the install on the server. The install endpoint may only
          // enqueue the install so treat this as "started" and then poll the
          // installed apps list to confirm the app appears there before
          // marking it as fully installed.
          const [res] = await Promise.all([
            fetch(`/api/app-lifecycle/${encodeURIComponent(app.urn)}/install`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                localSubdomain: app.localSubdomain || app.appSlug,
              }),
            }),
            minDelay(500),
          ]);

          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.message || `HTTP ${res.status}`);
          }

          // Start polling to confirm the app shows up in the installed apps
          // list. Give it a reasonable timeout (e.g. 60s) and poll interval.
          const pollInterval = 1000;
          const timeoutMs = 60_000;
          const start = Date.now();

          const checkInstalled = async (): Promise<boolean> => {
            try {
              const installedRes = await fetch('/api/apps/installed', { credentials: 'include' });
              if (!installedRes.ok) return false;
              const data = await installedRes.json().catch(() => ({}));
              const installed = data.installed || [];
              return installed.some((a: Record<string, Record<string, unknown>>) => a.info?.urn === app.urn);
            } catch {
              return false;
            }
          };

          // While polling, keep the state in 'installing'
          let confirmed = false;
          // Ensure UI shows installing immediately
          setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'installing' } : s)));

          while (Date.now() - start < timeoutMs) {
            // small delay between polls
            // eslint-disable-next-line no-await-in-loop
            await minDelay(pollInterval);
            // eslint-disable-next-line no-await-in-loop
            if (await checkInstalled()) {
              confirmed = true;
              break;
            }
          }

          if (confirmed) {
            setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'success' } : s)));
            // Installation confirmed — refresh installed apps list to replace
            // the optimistic entry with the real one.
            try {
              queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
            } catch (_e) {
              // ignore
            }
          } else {
            // If we never confirmed installation, mark as error but include
            // a helpful message so users know it may still be processing.
            setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'error', error: 'Installation not confirmed (timed out)' } : s)));
            // Remove optimistic installed entry on error/timeout so dashboard
            // doesn't keep showing a phantom installing app.
            try {
              const installedKey = getInstalledAppsQueryKey();
              const existing = (queryClient.getQueryData(installedKey) as { installed: Record<string, Record<string, unknown>>[] }) || {
                installed: [],
              };
              const filtered = existing.installed.filter((it) => it.info?.urn !== app.urn);
              queryClient.setQueryData(installedKey, { installed: filtered });
            } catch (_e) {
              // ignore
            }
          }
        } catch (e) {
          setStates((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'error', error: (e as Error).message } : s)));
          try {
            const installedKey = getInstalledAppsQueryKey();
            const existing = (queryClient.getQueryData(installedKey) as { installed: Record<string, Record<string, unknown>>[] }) || {
              installed: [],
            };
            const filtered = existing.installed.filter((it) => it.info?.urn !== app.urn);
            queryClient.setQueryData(installedKey, { installed: filtered });
          } catch (_e) {
            // ignore
          }
        }
      }

      setDone(true);
    };

    installAll();
  }, [apps]);

  const statusIcon = (status: InstallStatus) => {
    switch (status) {
      case 'pending':
        return <span className="text-muted-foreground">○</span>;
      case 'installing':
        return <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full" />;
      case 'success':
        return <span className="text-green-500">✓</span>;
      case 'error':
        return <span className="text-destructive">✕</span>;
    }
  };

  const completedCount = states.filter((s) => s.status === 'success').length;
  const errorCount = states.filter((s) => s.status === 'error').length;
  const processedCount = completedCount + errorCount;
  const progress = apps.length > 0 ? Math.round((processedCount / apps.length) * 100) : 0;

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold mb-1">{done ? 'Installation Complete' : 'Installing Apps'}</h2>
          <p className="text-sm text-muted-foreground">
            {done
              ? `${completedCount} installed${errorCount > 0 ? `, ${errorCount} failed` : ''}.`
              : `Installing ${processedCount + 1} of ${apps.length}...`}
          </p>
        </div>

        <div className="w-full bg-muted rounded-full h-2 mb-4 overflow-hidden">
          <div className="bg-primary h-2 rounded-full transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
        </div>

        <div className="space-y-1 max-h-[350px] overflow-y-auto pr-2">
          {states.map((state) => (
            <div key={state.app.appSlug} className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors">
              <span className="w-5 h-5 flex items-center justify-center text-sm font-semibold">{statusIcon(state.status)}</span>
              <img
                src={state.app.icon}
                alt=""
                className="w-6 h-6 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{state.app.name}</div>
                {state.error && <div className="text-xs text-destructive">{state.error}</div>}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end mt-6">
          {/* Allow users to continue even while installs are running. This button
              is intentionally always enabled (unless loading) so onboarding does
              not block the user. If installation completes naturally the
              original onComplete will also be called by the parent flow. */}
          <Button intent="primary" onClick={() => onCompleteRef.current()}>
            {done ? 'Continue' : 'Continue (apps installing in background)'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
