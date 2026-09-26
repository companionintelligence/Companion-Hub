import { getInstalledApps, installApp } from '@/api-client/sdk.gen';
import { pinInferenceModel, saveCloudProviderConfig, saveInferencePreferences } from '@/lib/inference/inference-api';
import {
  automaticRunnersForBackend,
  installAndStartInferenceRunners,
  type AutomaticInferenceRunnerResult,
} from '@/lib/inference/auto-inference-runners';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import { sdkResult } from '@/lib/sdk-unwrap';
import { fetchTrackedModels, parsePullProgress } from '@/lib/inference/tracked-models';
import { Button } from '@/components/ui/Button';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getInstalledAppsQueryKey, appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { addOptimisticInstalledApp, removeOptimisticInstalledApp } from '@/modules/app/helpers/optimistic-installed-apps';
import { Download, Loader2 } from 'lucide-react';
import { OnboardingAppIcon } from './onboarding-app-icon';
import { WizardCard } from './wizard-ui';
import type { OnboardingApp, AppInstallStatus, InstallSummary, AiSetupConfig } from '../helpers/types';
import { useTranslation } from 'react-i18next';

interface InstallStepProps {
  apps: OnboardingApp[];
  /** Exposure mode to use for all onboarding installs. Defaults to 'cloudflare'. */
  defaultExposureMode?: 'cloudflare' | 'tailscale' | 'local';
  /** Operator email/username used for sensible app-specific install defaults. */
  operatorUsername?: string;
  /** AI setup configuration from the previous step. */
  aiSetupConfig?: AiSetupConfig;
  onComplete: (summary: InstallSummary) => void;
  /**
   * When `false`, the install is deferred and this renders as a live review of the current
   * selection (no progress, no Continue button) until the parent flips it to `true`. Defaults
   * to `true` so existing callers auto-run on mount.
   */
  start?: boolean;
}

interface AppInstallState {
  app: OnboardingApp;
  status: AppInstallStatus;
  error?: string;
}

function buildSummary(states: AppInstallState[], continuedInBackground = false): InstallSummary {
  return {
    results: states.map((s) => ({ app: s.app, status: s.status, error: s.error })),
    running: states.filter((s) => s.status === 'running').length,
    incomplete: states.filter((s) => s.status === 'incomplete').length,
    failed: states.filter((s) => s.status === 'failed').length,
    total: states.length,
    continuedInBackground,
  };
}

type AiPhaseStatus = 'pending' | 'installing-runners' | 'configuring-cloud' | 'pulling-models' | 'pinning-models' | 'done' | 'skipped';

interface AiPhaseState {
  status: AiPhaseStatus;
  cloudConfigured: boolean;
  modelProgress: Record<string, number>; // modelId -> 0-100
  modelErrors: Record<string, string>;
  modelsDone: boolean;
  runnerResults: AutomaticInferenceRunnerResult[];
  error?: string;
}

export const InstallStep = ({
  apps,
  defaultExposureMode = 'cloudflare',
  operatorUsername,
  aiSetupConfig,
  onComplete,
  start = true,
}: InstallStepProps) => {
  const { t } = useTranslation();
  const [states, setStates] = useState<AppInstallState[]>(apps.map((app) => ({ app, status: 'queued' })));
  const [done, setDone] = useState(false);
  const [aiPhase, setAiPhase] = useState<AiPhaseState>({
    status: aiSetupConfig && !aiSetupConfig.skipped ? 'pending' : 'skipped',
    cloudConfigured: false,
    modelProgress: {},
    modelErrors: {},
    modelsDone: false,
    runnerResults: [],
  });
  const started = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const queryClient = useQueryClient();
  const canAutoInstallRunners = getTauriInvoke() !== null;

  const buildInstallBody = (app: OnboardingApp) => {
    const mode = app.exposureMode ?? defaultExposureMode;
    const body: Record<string, unknown> = {
      localSubdomain: app.localSubdomain || app.appSlug,
      exposureMode: mode,
      exposedLocal: mode === 'cloudflare',
      openPort: mode === 'local',
    };

    if (app.appSlug === 'ci-hermes' && operatorUsername?.trim()) {
      body.GATEWAY_ALLOWED_USERS = operatorUsername.trim();
    }

    return body;
  };

  // While the install is deferred (start === false), mirror the live selection so the
  // review list below the app picker reflects what the user has chosen.
  useEffect(() => {
    if (started.current) return;
    setStates(apps.map((app) => ({ app, status: 'queued' as AppInstallStatus })));
  }, [apps]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: queryClient is stable from useQueryClient
  useEffect(() => {
    if (started.current) return;
    if (!start) return;
    started.current = true;

    const installAll = async () => {
      const minDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // ─── AI Setup Phase ───────────────────────────────────────────────
      if (aiSetupConfig && !aiSetupConfig.skipped) {
        let automaticRunnerUrls = new Map<string, string>();
        const automaticRunners = automaticRunnersForBackend(aiSetupConfig.backend);

        // Native runner setup belongs in the desktop shell. It is deliberately
        // best-effort: unsupported hardware or one failed install must not
        // prevent cloud configuration, model pulls, or app installation. The
        // Apple Silicon default is a deliberate two-runner pair: mlx-dspark
        // serves chat and Ollama supplies embeddings.
        if (canAutoInstallRunners) {
          setAiPhase((prev) => ({ ...prev, status: 'installing-runners' }));
          try {
            const runnerResults = await installAndStartInferenceRunners(automaticRunners);
            setAiPhase((prev) => ({ ...prev, runnerResults }));
            automaticRunnerUrls = new Map(
              runnerResults.filter((result) => result.endpointUrl).map((result) => [result.runner, result.endpointUrl as string]),
            );
            const unavailableCount = runnerResults.filter((result) => result.state === 'failed' || result.state === 'skipped').length;
            if (unavailableCount > 0) {
              setAiPhase((prev) => ({
                ...prev,
                error: t('ONBOARDING_INFERENCE_RUNNERS_UNAVAILABLE', { count: unavailableCount }),
              }));
            }
          } catch {
            setAiPhase((prev) => ({
              ...prev,
              error: t('ONBOARDING_INFERENCE_RUNNERS_FAILED'),
            }));
          }
        }

        // Configure cloud providers
        if (aiSetupConfig.cloudProviders.length > 0) {
          setAiPhase((prev) => ({ ...prev, status: 'configuring-cloud' }));
          for (const cp of aiSetupConfig.cloudProviders) {
            try {
              await saveCloudProviderConfig({ provider: cp.provider, apiKey: cp.apiKey, enabled: cp.enabled });
            } catch {
              setAiPhase((prev) => ({
                ...prev,
                error: t('ONBOARDING_INSTALL_FAILED_CONFIGURE_PROVIDER', { provider: cp.provider, status: 0 }),
              }));
            }
          }
          setAiPhase((prev) => ({ ...prev, cloudConfigured: true }));
        }

        const installedSet = new Set(aiSetupConfig.installedCatalogIds ?? []);
        const availablePreferenceModelIds = new Set(aiSetupConfig.installedCatalogIds ?? []);
        const ollamaSelected = aiSetupConfig.ollamaSelectedModelIds ?? aiSetupConfig.selectedModels;
        const modelsToPull = ollamaSelected.filter((id) => !installedSet.has(id));

        if (aiSetupConfig.selectedModels.length > 0) {
          const modelErrors: Record<string, string> = {};
          const modelProgress: Record<string, number> = {};

          if (modelsToPull.length > 0) {
            setAiPhase((prev) => ({ ...prev, status: 'pulling-models', modelErrors }));

            const pullWaitMs = 60_000;
            const pullWaitStart = Date.now();
            while (Date.now() - pullWaitStart < pullWaitMs) {
              const tracked = await fetchTrackedModels();
              const parsed = parsePullProgress(modelsToPull, aiSetupConfig.installedCatalogIds ?? [], tracked);
              Object.assign(modelProgress, parsed.progressById);
              for (const [id, msg] of Object.entries(parsed.errorsById)) {
                modelErrors[id] = msg;
              }
              for (const id of parsed.pulledIds) {
                availablePreferenceModelIds.add(id);
              }
              setAiPhase((prev) => ({ ...prev, modelProgress: { ...modelProgress }, modelErrors: { ...modelErrors } }));
              if (parsed.allDone) break;
              await minDelay(1000);
            }

            const finalTracked = await fetchTrackedModels();
            const finalParsed = parsePullProgress(modelsToPull, aiSetupConfig.installedCatalogIds ?? [], finalTracked);
            Object.assign(modelProgress, finalParsed.progressById);
            for (const [id, msg] of Object.entries(finalParsed.errorsById)) {
              modelErrors[id] = msg;
            }
            for (const id of finalParsed.pulledIds) {
              availablePreferenceModelIds.add(id);
            }

            if (Object.keys(modelErrors).length > 0) {
              setAiPhase((prev) => ({
                ...prev,
                modelProgress: { ...modelProgress },
                modelErrors: { ...modelErrors },
                error: t('ONBOARDING_INSTALL_MODEL_DOWNLOADS_FAILED', { count: Object.keys(modelErrors).length }),
              }));
            }
          }

          setAiPhase((prev) => ({ ...prev, status: 'pinning-models', modelErrors }));
          const pinTracked = await fetchTrackedModels();
          const pinableIds = new Set(
            pinTracked.filter((m) => m.state === 'pulled' || m.state === 'loaded' || m.state === 'pinned').map((m) => m.catalogId),
          );

          for (const modelId of ollamaSelected) {
            if (!pinableIds.has(modelId)) continue;
            try {
              await pinInferenceModel(modelId);
            } catch {
              // Non-fatal
            }
          }
        }

        const resolvedModelPreference = aiSetupConfig.preferredModelId;
        const resolvedEmbeddingPreference = aiSetupConfig.preferredEmbeddingModelId;
        const resolvedVisionPreference = aiSetupConfig.preferredVisionModelId;
        const configuredOrAutomaticUrl = (configured: string | undefined, runner: string) =>
          configured?.trim() || automaticRunnerUrls.get(runner) || null;

        try {
          await saveInferencePreferences({
            backend: aiSetupConfig.backend,
            model: resolvedModelPreference && availablePreferenceModelIds.has(resolvedModelPreference) ? resolvedModelPreference : null,
            embeddingModel:
              resolvedEmbeddingPreference && availablePreferenceModelIds.has(resolvedEmbeddingPreference) ? resolvedEmbeddingPreference : null,
            visionModel: resolvedVisionPreference && availablePreferenceModelIds.has(resolvedVisionPreference) ? resolvedVisionPreference : null,
            vllmApiKey: aiSetupConfig.vllmApiKey ?? null,
            vllmUrl: configuredOrAutomaticUrl(aiSetupConfig.vllmUrl, 'vllm'),
            omlxUrl: configuredOrAutomaticUrl(aiSetupConfig.omlxUrl, 'omlx'),
            decodeEndpoint: aiSetupConfig.decodeEndpoint ?? null,
            encodeEndpoint: aiSetupConfig.encodeEndpoint ?? null,
          });
        } catch {
          setAiPhase((prev) => ({ ...prev, error: t('ONBOARDING_INSTALL_FAILED_SAVE_PREFERRED_BACKEND', { status: 0 }) }));
        }

        setAiPhase((prev) => ({ ...prev, status: 'done', modelsDone: true }));
      }

      // ─── App Install Phase ────────────────────────────────────────────
      const finalStates: AppInstallState[] = apps.map((app) => ({ app, status: 'queued' as AppInstallStatus }));
      const stateAt = (index: number, app: OnboardingApp): AppInstallState => finalStates[index] ?? { app, status: 'queued' };

      const fetchInstalledStatusMap = async (): Promise<Map<string, 'running' | 'installing' | 'install_failed'>> => {
        try {
          const installedResult = await sdkResult(getInstalledApps());
          if (!installedResult.ok) return new Map();
          const data = (installedResult.data ?? {}) as { installed?: Array<{ info?: { urn?: string }; app?: { status?: string } }> };
          const installed = data.installed || [];
          const statusMap = new Map<string, 'running' | 'installing' | 'install_failed'>();
          for (const item of installed) {
            const urn = item.info?.urn;
            if (!urn) continue;
            const appStatus = item.app?.status ?? '';
            if (appStatus === 'running') {
              statusMap.set(urn, 'running');
            } else if (appStatus === 'install_failed') {
              statusMap.set(urn, 'install_failed');
            } else {
              statusMap.set(urn, 'installing');
            }
          }
          return statusMap;
        } catch {
          return new Map();
        }
      };

      const enqueueApp = async (index: number, app: OnboardingApp) => {
        if (!app.urn) {
          finalStates[index] = { ...stateAt(index, app), status: 'failed', error: t('ONBOARDING_APP_NOT_AVAILABLE_IN_STORE') };
          setStates([...finalStates]);
          return;
        }

        finalStates[index] = { ...stateAt(index, app), status: 'installing' };
        setStates([...finalStates]);

        try {
          addOptimisticInstalledApp(queryClient, {
            urn: app.urn,
            // The dashboard's name, not the wizard's: `app.name` can be an onboarding-only override,
            // and using it here makes the tile rename itself once the real row lands.
            name: app.storeName ?? app.name,
            slug: app.appSlug,
            localSubdomain: app.localSubdomain,
          });
        } catch (_e) {
          // Non-fatal; proceed without optimistic cache
        }

        try {
          const installBody = buildInstallBody(app);
          const installResult = await sdkResult(
            installApp({
              path: { urn: app.urn },
              body: installBody,
            } as Parameters<typeof installApp>[0]),
          );

          if (!installResult.ok) {
            const data = (installResult.data ?? {}) as { message?: string };
            throw new Error(data.message || `HTTP ${installResult.status}`);
          }
        } catch (e) {
          finalStates[index] = { ...stateAt(index, app), status: 'failed', error: (e as Error).message };
          setStates([...finalStates]);
          // The app never made it into the database, so retract the row we invented for it. Left in
          // the cache it renders on the dashboard as a spinner for an app that will never exist.
          removeOptimisticInstalledApp(queryClient, app.urn);
          try {
            await queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
            await queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
          } catch (_e) {
            // ignore
          }
        }
      };

      // Enqueue every selected app immediately; the backend serializes Docker pulls.
      await Promise.all(apps.map((app, index) => enqueueApp(index, app)));

      const pollInterval = 1000;
      const timeoutMs = 120_000;
      const monitorStart = Date.now();

      while (Date.now() - monitorStart < timeoutMs) {
        const pending = finalStates.map((state, index) => ({ state, index })).filter(({ state }) => state.status === 'installing' && state.app.urn);

        if (pending.length === 0) {
          break;
        }

        const statusMap = await fetchInstalledStatusMap();

        for (const { state, index } of pending) {
          const urn = state.app.urn;
          if (!urn) continue;

          const confirmedStatus = statusMap.get(urn) ?? false;
          if (confirmedStatus === 'running') {
            finalStates[index] = { ...stateAt(index, state.app), status: 'running' };
          } else if (confirmedStatus === 'install_failed') {
            finalStates[index] = {
              ...stateAt(index, state.app),
              status: 'failed',
              error: t('ONBOARDING_INSTALL_FAILED_RETRY_MY_APPS'),
            };
          }
        }

        setStates([...finalStates]);

        if (finalStates.every((state) => state.status !== 'installing')) {
          break;
        }

        await minDelay(pollInterval);
      }

      for (let i = 0; i < finalStates.length; i++) {
        const state = finalStates[i];
        if (!state || state.status !== 'installing') {
          continue;
        }

        finalStates[i] = {
          ...stateAt(i, state.app),
          status: 'incomplete',
          error: t('ONBOARDING_INSTALL_STARTED_NOT_CONFIRMED'),
        };
      }

      setStates([...finalStates]);

      try {
        queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
        queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
      } catch (_e) {
        // ignore
      }

      setDone(true);
    };

    installAll();
  }, [apps, defaultExposureMode, operatorUsername, start]);

  const statusIcon = (status: AppInstallStatus) => {
    switch (status) {
      case 'queued':
        return (
          <span className="text-muted-foreground" data-testid="status-queued">
            ○
          </span>
        );
      case 'installing':
        return <Loader2 className="w-4 h-4 animate-spin text-primary" data-testid="status-installing" />;
      case 'running':
        return (
          <span className="text-success" data-testid="status-running">
            ✓
          </span>
        );
      case 'incomplete':
        return (
          <span className="text-warning" data-testid="status-incomplete">
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
        return t('ONBOARDING_INSTALL_STATUS_QUEUED');
      case 'installing':
        return t('ONBOARDING_INSTALL_STATUS_INSTALLING');
      case 'running':
        return t('COMMON_RUNNING');
      case 'incomplete':
        return t('ONBOARDING_INSTALL_STATUS_NOT_CONFIRMED');
      case 'failed':
        return t('COMMON_FAILED');
    }
  };

  const runningCount = states.filter((s) => s.status === 'running').length;
  const failedCount = states.filter((s) => s.status === 'failed').length;
  const incompleteCount = states.filter((s) => s.status === 'incomplete').length;
  const processedCount = runningCount + failedCount + incompleteCount;
  const progress = apps.length > 0 ? Math.round((processedCount / apps.length) * 100) : 0;
  const hasAiWork = aiPhase.status !== 'skipped';
  const aiInProgress = hasAiWork && aiPhase.status !== 'done';
  const unavailableRunnerCount = aiPhase.runnerResults.filter((result) => result.state === 'failed' || result.state === 'skipped').length;

  const summaryParts: string[] = [];
  if (runningCount > 0) summaryParts.push(t('ONBOARDING_COMPLETE_RUNNING_COUNT', { count: runningCount }));
  if (incompleteCount > 0) summaryParts.push(t('ONBOARDING_INSTALL_NOT_CONFIRMED_COUNT', { count: incompleteCount }));
  if (failedCount > 0) summaryParts.push(t('ONBOARDING_COMPLETE_FAILED_COUNT', { count: failedCount }));

  const progressText = (() => {
    if (!start) {
      if (apps.length === 0) return t('ONBOARDING_CHOOSE_APPS_THEN_FINISH');
      return t('ONBOARDING_APPS_READY_TO_INSTALL', { count: apps.length });
    }

    if (done) {
      if (apps.length === 0) {
        return hasAiWork ? t('ONBOARDING_AI_SETUP_COMPLETE_NO_APPS') : t('ONBOARDING_NO_APPS_SELECTED_FOR_INSTALL');
      }
      return summaryParts.length > 0 ? `${summaryParts.join(', ')}.` : t('ONBOARDING_NO_APP_INSTALLS_NEEDED');
    }

    if (apps.length === 0) {
      return aiInProgress ? t('ONBOARDING_CONFIGURING_AI_SETUP') : t('ONBOARDING_NO_APPS_SELECTED_FOR_INSTALL');
    }

    return t('ONBOARDING_INSTALLING_PROGRESS', { current: processedCount + 1, total: apps.length });
  })();

  const hasAppWork = apps.length > 0 && !done;
  const continueButtonLabel = done
    ? t('COMMON_CONTINUE')
    : hasAppWork && aiInProgress
      ? t('ONBOARDING_CONTINUE_APPS_AI_BACKGROUND')
      : hasAppWork
        ? t('ONBOARDING_CONTINUE_APPS_BACKGROUND')
        : aiInProgress
          ? t('ONBOARDING_CONTINUE_AI_BACKGROUND')
          : t('COMMON_CONTINUE');

  return (
    <WizardCard>
      <div className="mb-5 flex items-center gap-3">
        <span className="text-primary [&_svg]:h-6 [&_svg]:w-6">
          <Download />
        </span>
        <div>
          <h2 className="text-lg font-bold tracking-tight sm:text-xl">
            {apps.length === 0
              ? t('ONBOARDING_NO_APPS_SELECTED_TITLE')
              : start
                ? done
                  ? t('ONBOARDING_INSTALLATION_COMPLETE')
                  : t('ONBOARDING_INSTALLING_APPS')
                : t('ONBOARDING_REVIEW_APPS')}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground" data-testid="install-progress-text">
            {progressText}
          </p>
        </div>
      </div>

      {start && apps.length > 0 && (
        <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-2 rounded-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
        </div>
      )}

      {/* AI Setup Phase */}
      {start && aiPhase.status !== 'skipped' && (
        <div className="mb-4 space-y-1" data-testid="ai-phase-section">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{t('ONBOARDING_AI_SETUP')}</div>
          {canAutoInstallRunners && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm" data-testid="inference-runners-phase">
              <span className="w-4 text-center">
                {aiPhase.runnerResults.length > 0
                  ? aiPhase.runnerResults.some((result) => result.state === 'failed')
                    ? '✕'
                    : '✓'
                  : aiPhase.status === 'installing-runners'
                    ? '●'
                    : '○'}
              </span>
              <span className="flex-1">{t('ONBOARDING_INFERENCE_RUNNERS')}</span>
              {unavailableRunnerCount > 0 && (
                <span className="text-xs text-warning">{t('ONBOARDING_INFERENCE_RUNNERS_UNAVAILABLE', { count: unavailableRunnerCount })}</span>
              )}
            </div>
          )}
          {aiSetupConfig?.cloudProviders && aiSetupConfig.cloudProviders.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="w-4 text-center">{aiPhase.cloudConfigured ? '✓' : aiPhase.status === 'configuring-cloud' ? '●' : '○'}</span>
              <span>{t('ONBOARDING_CLOUD_PROVIDERS_CONFIGURED')}</span>
            </div>
          )}
          {aiSetupConfig?.selectedModels.map((modelId) => (
            <div key={modelId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="w-4 text-center">
                {aiPhase.modelErrors[modelId]
                  ? '✕'
                  : (aiPhase.modelProgress[modelId] ?? 0) >= 100
                    ? '✓'
                    : aiPhase.status === 'pulling-models'
                      ? '●'
                      : '○'}
              </span>
              <span className="flex-1">
                {modelId}
                {modelId === aiSetupConfig.preferredModelId && <span className="ml-2 text-xs text-primary">{t('ONBOARDING_AGENT_DEFAULT')}</span>}
              </span>
              {aiPhase.modelErrors[modelId] ? (
                <span className="text-xs text-destructive max-w-[200px] truncate" title={aiPhase.modelErrors[modelId]}>
                  {t('ONBOARDING_SKIPPED')}
                </span>
              ) : (
                aiPhase.status === 'pulling-models' &&
                (aiPhase.modelProgress[modelId] ?? 0) < 100 && (
                  <span className="text-xs text-muted-foreground">
                    {(aiPhase.modelProgress[modelId] ?? 0) > 0 ? `${aiPhase.modelProgress[modelId]}%` : t('ONBOARDING_INSTALL_STATUS_DOWNLOADING')}
                  </span>
                )
              )}
            </div>
          ))}
          {aiPhase.error && (
            <div className="px-3 py-1 text-xs text-warning" data-testid="ai-phase-warning">
              {aiPhase.error}
            </div>
          )}
          {aiSetupConfig?.selectedModels && aiSetupConfig.selectedModels.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="w-4 text-center">{aiPhase.status === 'done' ? '✓' : aiPhase.status === 'pinning-models' ? '●' : '○'}</span>
              <span>{t('ONBOARDING_PIN_MODELS')}</span>
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
            <OnboardingAppIcon app={state.app} size={36} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{state.app.name}</div>
              <div className="text-xs text-muted-foreground">{statusLabel(state.status)}</div>
              {state.error && <div className="text-xs text-destructive">{state.error}</div>}
            </div>
          </div>
        ))}
      </div>

      {start && (
        <div className="mt-6 flex items-center justify-end border-t border-border pt-5">
          <Button
            intent="primary"
            onClick={() => {
              const backgroundAppsPending = (!done && apps.length > 0) || incompleteCount > 0;
              const continuedInBackground = backgroundAppsPending || aiInProgress;
              onCompleteRef.current(buildSummary(states, continuedInBackground));
            }}
            data-testid="install-continue-btn"
          >
            {continueButtonLabel}
          </Button>
        </div>
      )}
    </WizardCard>
  );
};
