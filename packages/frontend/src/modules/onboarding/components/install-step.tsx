import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getInstalledAppsQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { OnboardingApp, AppInstallStatus, InstallSummary, AiSetupConfig } from '../helpers/types';

interface InstallStepProps {
  apps: OnboardingApp[];
  /** Exposure mode to use for all onboarding installs. Defaults to 'cloudflare'. */
  defaultExposureMode?: 'cloudflare' | 'tailscale' | 'local';
  /** AI setup configuration from the previous step. */
  aiSetupConfig?: AiSetupConfig;
  onComplete: (summary: InstallSummary) => void;
}

interface AppInstallState {
  app: OnboardingApp;
  status: AppInstallStatus;
  error?: string;
}

function buildSummary(states: AppInstallState[]): InstallSummary {
  return {
    results: states.map((s) => ({ app: s.app, status: s.status, error: s.error })),
    running: states.filter((s) => s.status === 'running').length,
    incomplete: states.filter((s) => s.status === 'incomplete').length,
    failed: states.filter((s) => s.status === 'failed').length,
    total: states.length,
  };
}

type AiPhaseStatus = 'pending' | 'configuring-cloud' | 'pulling-models' | 'pinning-models' | 'done' | 'skipped';

interface AiPhaseState {
  status: AiPhaseStatus;
  cloudConfigured: boolean;
  modelProgress: Record<string, number>; // modelId -> 0-100
  modelsDone: boolean;
  error?: string;
}

export const InstallStep = ({ apps, defaultExposureMode = 'cloudflare', aiSetupConfig, onComplete }: InstallStepProps) => {
  const [states, setStates] = useState<AppInstallState[]>(apps.map((app) => ({ app, status: 'queued' })));
  const [done, setDone] = useState(false);
  const [aiPhase, setAiPhase] = useState<AiPhaseState>({
    status: aiSetupConfig && !aiSetupConfig.skipped ? 'pending' : 'skipped',
    cloudConfigured: false,
    modelProgress: {},
    modelsDone: false,
  });
  const started = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const queryClient = useQueryClient();

  // biome-ignore lint/correctness/useExhaustiveDependencies: queryClient is stable from useQueryClient
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const installAll = async () => {
      const minDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // ─── AI Setup Phase ───────────────────────────────────────────────
      if (aiSetupConfig && !aiSetupConfig.skipped) {
        // Configure cloud providers
        if (aiSetupConfig.cloudProviders.length > 0) {
          setAiPhase((prev) => ({ ...prev, status: 'configuring-cloud' }));
          for (const cp of aiSetupConfig.cloudProviders) {
            try {
              const res = await apiFetch('/api/inference/cloud-providers', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: cp.provider, apiKey: cp.apiKey, enabled: cp.enabled }),
              });
              if (!res.ok) {
                setAiPhase((prev) => ({ ...prev, error: `Failed to configure ${cp.provider}: HTTP ${res.status}` }));
              }
            } catch {
              // Non-fatal — continue with other providers
            }
          }
          setAiPhase((prev) => ({ ...prev, cloudConfigured: true }));
        }

        // Pull selected models
        if (aiSetupConfig.selectedModels.length > 0) {
          setAiPhase((prev) => ({ ...prev, status: 'pulling-models' }));
          for (const modelId of aiSetupConfig.selectedModels) {
            try {
              const res = await apiFetch('/api/inference/models/pull', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId }),
              });
              if (!res.ok) {
                setAiPhase((prev) => ({ ...prev, error: `Failed to pull model ${modelId}: HTTP ${res.status}` }));
              }
            } catch {
              // Non-fatal
            }
          }

          // Poll for pull progress
          const pollPullProgress = async (): Promise<boolean> => {
            try {
              const res = await apiFetch('/api/inference/models/tracked', { credentials: 'include' });
              if (!res.ok) return false;
              const tracked = await res.json();
              const progress: Record<string, number> = {};
              let allDone = true;
              for (const model of tracked) {
                if (aiSetupConfig.selectedModels.includes(model.catalogId)) {
                  progress[model.catalogId] =
                    model.pullProgress ?? (model.state === 'pulled' || model.state === 'loaded' || model.state === 'pinned' ? 100 : 0);
                  if (model.state !== 'pulled' && model.state !== 'loaded' && model.state !== 'pinned' && model.state !== 'error') {
                    allDone = false;
                  }
                }
              }
              setAiPhase((prev) => ({ ...prev, modelProgress: progress }));
              return allDone;
            } catch {
              return false;
            }
          };

          const pullTimeout = 600_000; // 10 min
          const pullStart = Date.now();
          let pullsComplete = false;
          while (Date.now() - pullStart < pullTimeout) {
            await minDelay(2000);
            if (await pollPullProgress()) {
              pullsComplete = true;
              break;
            }
          }

          if (!pullsComplete) {
            setAiPhase((prev) => ({ ...prev, error: 'Model pulls are still in progress — they will complete in the background.' }));
          }

          // Pin models only if pulls completed
          if (pullsComplete) {
            setAiPhase((prev) => ({ ...prev, status: 'pinning-models' }));
            for (const modelId of aiSetupConfig.selectedModels) {
              try {
                await apiFetch('/api/inference/models/pin', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ modelId }),
                });
              } catch {
                // Non-fatal
              }
            }
          }
        }

        setAiPhase((prev) => ({ ...prev, status: 'done', modelsDone: true }));
      }

      // ─── App Install Phase ────────────────────────────────────────────
      const finalStates: AppInstallState[] = apps.map((app) => ({ app, status: 'queued' as AppInstallStatus }));
      const stateAt = (index: number, app: OnboardingApp): AppInstallState => finalStates[index] ?? { app, status: 'queued' };

      for (let i = 0; i < apps.length; i++) {
        const app = apps[i];
        if (!app) continue;

        if (!app.urn) {
          finalStates[i] = { ...stateAt(i, app), status: 'failed', error: 'Not available in store' };
          setStates([...finalStates]);
          await minDelay(500);
          continue;
        }

        finalStates[i] = { ...stateAt(i, app), status: 'installing' };
        setStates([...finalStates]);

        // Add an optimistic entry to the installed apps cache so the dashboard
        // and other pages show the app as "installing" while the server
        // processes the request.
        try {
          const installedKey = getInstalledAppsQueryKey();
          const existing = (queryClient.getQueryData(installedKey) as Record<string, unknown>) || { installed: [] };
          const installedList = (existing.installed ?? []) as Array<Record<string, Record<string, unknown>>>;
          const filtered = installedList.filter((it) => it.info?.urn !== app.urn);
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
          // Non-fatal; proceed without optimistic cache
        }

        try {
          const [res] = await Promise.all([
            apiFetch(`/api/app-lifecycle/${encodeURIComponent(app.urn)}/install`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                localSubdomain: app.localSubdomain || app.appSlug,
                exposureMode: defaultExposureMode,
                exposedLocal: defaultExposureMode === 'cloudflare',
                openPort: false,
              }),
            }),
            minDelay(500),
          ]);

          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.message || `HTTP ${res.status}`);
          }

          // Poll to confirm the app shows up in the installed apps list with
          // a status that indicates it is actually running / healthy.
          const pollInterval = 1000;
          const timeoutMs = 60_000;
          const start = Date.now();

          const checkRunning = async (): Promise<'running' | 'installing' | false> => {
            try {
              const installedRes = await apiFetch('/api/apps/installed', { credentials: 'include' });
              if (!installedRes.ok) return false;
              const data = await installedRes.json().catch(() => ({}));
              const installed = data.installed || [];
              const match = installed.find((a: Record<string, Record<string, unknown>>) => a.info?.urn === app.urn);
              if (!match) return false;
              const appStatus = (match.app?.status as string) ?? '';
              if (appStatus === 'running') return 'running';
              // Present in list but not yet running
              return 'installing';
            } catch {
              return false;
            }
          };

          let confirmedStatus: 'running' | 'installing' | false = false;

          while (Date.now() - start < timeoutMs) {
            await minDelay(pollInterval);
            confirmedStatus = await checkRunning();
            if (confirmedStatus === 'running') break;
          }

          if (confirmedStatus === 'running') {
            finalStates[i] = { ...stateAt(i, app), status: 'running' };
            setStates([...finalStates]);
            try {
              queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
            } catch (_e) {
              // ignore
            }
          } else {
            // The install request was accepted but the app was not confirmed
            // running within the timeout. Mark as incomplete, not success.
            finalStates[i] = {
              ...stateAt(i, app),
              status: 'incomplete',
              error: 'Install started but not yet confirmed running',
            };
            setStates([...finalStates]);
            // Keep optimistic cache entry — the app likely still exists on
            // the server, just hasn't fully converged yet.
          }
        } catch (e) {
          finalStates[i] = { ...stateAt(i, app), status: 'failed', error: (e as Error).message };
          setStates([...finalStates]);
          try {
            const installedKey = getInstalledAppsQueryKey();
            const existing = (queryClient.getQueryData(installedKey) as Record<string, unknown>) || { installed: [] };
            const installedList = (existing.installed ?? []) as Array<Record<string, Record<string, unknown>>>;
            const filtered = installedList.filter((it) => it.info?.urn !== app.urn);
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

  const statusIcon = (status: AppInstallStatus) => {
    switch (status) {
      case 'queued':
        return (
          <span className="text-muted-foreground" data-testid="status-queued">
            ○
          </span>
        );
      case 'installing':
        return <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full" data-testid="status-installing" />;
      case 'running':
        return (
          <span className="text-green-500" data-testid="status-running">
            ✓
          </span>
        );
      case 'incomplete':
        return (
          <span className="text-yellow-500" data-testid="status-incomplete">
            ⏳
          </span>
        );
      case 'failed':
        return (
          <span className="text-destructive" data-testid="status-failed">
            ✕
          </span>
        );
    }
  };

  const statusLabel = (status: AppInstallStatus) => {
    switch (status) {
      case 'queued':
        return 'Queued';
      case 'installing':
        return 'Installing…';
      case 'running':
        return 'Running';
      case 'incomplete':
        return 'Not yet confirmed';
      case 'failed':
        return 'Failed';
    }
  };

  const runningCount = states.filter((s) => s.status === 'running').length;
  const failedCount = states.filter((s) => s.status === 'failed').length;
  const incompleteCount = states.filter((s) => s.status === 'incomplete').length;
  const processedCount = runningCount + failedCount + incompleteCount;
  const progress = apps.length > 0 ? Math.round((processedCount / apps.length) * 100) : 0;
  const hasAiWork = aiPhase.status !== 'skipped';
  const aiInProgress = hasAiWork && aiPhase.status !== 'done';

  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(`${runningCount} running`);
  if (incompleteCount > 0) summaryParts.push(`${incompleteCount} not yet confirmed`);
  if (failedCount > 0) summaryParts.push(`${failedCount} failed`);

  const progressText = (() => {
    if (done) {
      if (apps.length === 0) {
        return hasAiWork ? 'AI setup complete. No apps selected for installation.' : 'No apps selected for installation.';
      }
      return summaryParts.length > 0 ? `${summaryParts.join(', ')}.` : 'No app installs were needed.';
    }

    if (apps.length === 0) {
      return aiInProgress ? 'Configuring AI setup…' : 'No apps selected for installation.';
    }

    return `Installing ${processedCount + 1} of ${apps.length}…`;
  })();

  const hasAppWork = apps.length > 0 && !done;
  const continueButtonLabel = done
    ? 'Continue'
    : hasAppWork && aiInProgress
      ? 'Continue (apps and AI setup in background)'
      : hasAppWork
        ? 'Continue (apps installing in background)'
        : aiInProgress
          ? 'Continue (AI setup in background)'
          : 'Continue';

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4">
          <h2 className="text-xl font-semibold mb-1">
            {apps.length === 0 ? 'No Apps Selected' : done ? 'Installation Complete' : 'Installing Apps'}
          </h2>
          <p className="text-sm text-muted-foreground" data-testid="install-progress-text">
            {progressText}
          </p>
        </div>

        {apps.length > 0 && (
          <div className="w-full bg-muted rounded-full h-2 mb-4 overflow-hidden">
            <div className="bg-primary h-2 rounded-full transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
          </div>
        )}

        {/* AI Setup Phase */}
        {aiPhase.status !== 'skipped' && (
          <div className="mb-4 space-y-1" data-testid="ai-phase-section">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">AI Setup</div>
            {aiSetupConfig?.cloudProviders && aiSetupConfig.cloudProviders.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="w-4 text-center">{aiPhase.cloudConfigured ? '✓' : aiPhase.status === 'configuring-cloud' ? '●' : '○'}</span>
                <span>Cloud providers configured</span>
              </div>
            )}
            {aiSetupConfig?.selectedModels.map((modelId) => (
              <div key={modelId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="w-4 text-center">
                  {(aiPhase.modelProgress[modelId] ?? 0) >= 100 ? '✓' : aiPhase.status === 'pulling-models' ? '●' : '○'}
                </span>
                <span className="flex-1">{modelId}</span>
                {aiPhase.status === 'pulling-models' && (aiPhase.modelProgress[modelId] ?? 0) < 100 && (
                  <span className="text-xs text-muted-foreground">{aiPhase.modelProgress[modelId] ?? 0}%</span>
                )}
              </div>
            ))}
            {aiSetupConfig?.selectedModels && aiSetupConfig.selectedModels.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="w-4 text-center">{aiPhase.status === 'done' ? '✓' : aiPhase.status === 'pinning-models' ? '●' : '○'}</span>
                <span>Pin models</span>
              </div>
            )}
            {aiPhase.status !== 'done' && aiPhase.status !== 'pending' && <div className="h-px bg-border my-2" />}
          </div>
        )}

        {/* App Install Phase */}
        <div className="space-y-1 max-h-[350px] overflow-y-auto pr-2" data-testid="install-app-list">
          {states.map((state) => (
            <div
              key={state.app.appSlug}
              className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors"
              data-testid={`install-row-${state.app.appSlug}`}
            >
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
                <div className="text-xs text-muted-foreground">{statusLabel(state.status)}</div>
                {state.error && <div className="text-xs text-destructive">{state.error}</div>}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end mt-6">
          <Button intent="primary" onClick={() => onCompleteRef.current(buildSummary(states))} data-testid="install-continue-btn">
            {continueButtonLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
