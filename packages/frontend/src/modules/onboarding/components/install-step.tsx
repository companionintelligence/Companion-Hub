import { getInstalledApps, installApp } from '@/api-client/sdk.gen';
import { pinInferenceModel, saveCloudProviderConfig, saveInferencePreferences } from '@/lib/inference/inference-api';
import {
  automaticRunnersForBackend,
  installAndStartInferenceRunners,
  type AutomaticInferenceRunnerResult,
} from '@/lib/inference/auto-inference-runners';
import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { sdkResult } from '@/lib/sdk-unwrap';
import { describePullStartError, fetchTrackedModels, parsePullProgress, preferenceModelId } from '@/lib/inference/tracked-models';
import { claimOnboardingInstallUrn, onboardingInstallUrnClaimed, releaseOnboardingInstallUrn } from '../helpers/install-session';
import type { TrackedModel } from '@ci-hub/common/types';
import { Button } from '@/components/ui/Button';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getInstalledAppsQueryKey, appContextQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { addOptimisticInstalledApp, removeOptimisticInstalledApp } from '@/modules/app/helpers/optimistic-installed-apps';
import { Download, Loader2 } from 'lucide-react';
import { FailureLog } from './ai-setup/failure-log';
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
  /**
   * A reload of an install already underway. Cloud keys and runner setup already ran; asking
   * again would blank a saved key or start a second runner install.
   */
  resume?: boolean;
  /**
   * Downloads the Hub refused to start, by model id, as the onboarding page heard them. A refused download is
   * never tracked, so without this the row reads "Downloading..." for good and the pins never finish.
   */
  pullErrorsById?: Record<string, string>;
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

/** How often the step asks the Hub about the downloads and the apps. */
const POLL_INTERVAL_MS = 1000;
/**
 * How often it asks once an app is past the confirm window, or the downloads have run past SLOW_POLL_AFTER_MS.
 * The installed-apps list builds store details for every app and can take seconds on a busy Hub.
 */
const SLOW_POLL_INTERVAL_MS = 5000;
const SLOW_POLL_AFTER_MS = 120_000;
/** An app still installing after this long reads "Not yet confirmed". The step keeps asking about it. */
const APP_CONFIRM_WINDOW_MS = 120_000;
/** A status request that hangs must not stop the polling, so the step stops waiting for it after this long. */
const REQUEST_TIMEOUT_MS = 15_000;

function withTimeout<T>(request: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The defaults the step stores. Each is the chosen id, or null while that model is not usable. */
interface PreferenceModels {
  model: string | null;
  embeddingModel: string | null;
  visionModel: string | null;
}

const samePreferences = (a: PreferenceModels, b: PreferenceModels) =>
  a.model === b.model && a.embeddingModel === b.embeddingModel && a.visionModel === b.visionModel;

const isOnDisk = (model: TrackedModel) => model.state === 'pulled' || model.state === 'loaded' || model.state === 'pinned';

type AiPhaseStatus = 'pending' | 'installing-runners' | 'configuring-cloud' | 'pulling-models' | 'pinning-models' | 'done' | 'skipped';

interface AiPhaseState {
  status: AiPhaseStatus;
  cloudConfigured: boolean;
  modelProgress: Record<string, number>; // modelId -> 0-100
  modelErrors: Record<string, string>;
  modelsDone: boolean;
  runnerResults: AutomaticInferenceRunnerResult[];
  /**
   * Each chosen model that was not pinned, with the reason. Set when the first pin fails, and again once every
   * download has settled and its pin has run. Absent when the step ended before it got to the pins, which is not a
   * pin that happened either.
   */
  pinFailures?: Record<string, string>;
  /**
   * Set when the Hub refused more than one model and gave each the same reason, which is then said once above the
   * list. A GPU whose memory the Hub does not know refuses every pin with one long sentence.
   */
  pinRefusal?: string;
  error?: string;
}

export const InstallStep = ({
  apps,
  defaultExposureMode = 'cloudflare',
  operatorUsername,
  aiSetupConfig,
  onComplete,
  start = true,
  resume = false,
  pullErrorsById,
}: InstallStepProps) => {
  const { t } = useTranslation();
  const [states, setStates] = useState<AppInstallState[]>(apps.map((app) => ({ app, status: 'queued' })));
  const [done, setDone] = useState(false);
  const [aiPhase, setAiPhase] = useState<AiPhaseState>({
    status: aiSetupConfig && !aiSetupConfig.skipped ? 'pending' : 'skipped',
    cloudConfigured: false,
    // A model the engine already had is done before the first poll.
    modelProgress: Object.fromEntries((aiSetupConfig?.installedCatalogIds ?? []).map((id) => [id, 100])),
    modelErrors: {},
    modelsDone: false,
    runnerResults: [],
  });
  const started = useRef(false);
  // Set only when the step goes away. A prop change must not stop the run: `started` keeps the
  // effect from starting another, so the step would sit on its spinners for good.
  const unmounted = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  // The install effect runs once, and the page hears about refused downloads after it started.
  const pullErrorsRef = useRef(pullErrorsById);
  pullErrorsRef.current = pullErrorsById;
  const queryClient = useQueryClient();
  // The phone app is a Tauri webview too, but it has no runner installer.
  const canAutoInstallRunners = isTauriDesktopApp();

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

  useEffect(() => {
    unmounted.current = false;
    return () => {
      // The claims stay: a run underway still sends its requests, so a remount must not send them again.
      unmounted.current = true;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: queryClient is stable from useQueryClient
  useEffect(() => {
    if (started.current) return;
    if (!start) return;
    started.current = true;

    const preexistingClaims = new Set(apps.flatMap((app) => (app.urn && onboardingInstallUrnClaimed(app.urn) ? [app.urn] : [])));
    for (const app of apps) {
      if (!app.urn || preexistingClaims.has(app.urn)) continue;
      claimOnboardingInstallUrn(app.urn);
    }

    // True once the step is gone. It stops the polling and the pinning, not the requests before
    // them. Continue says the setup carries on in the background, and an unsent request is lost.
    const cancelled = () => unmounted.current;

    const installAll = async () => {
      const minDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const installedCatalogIds = aiSetupConfig?.installedCatalogIds ?? [];
      const availablePreferenceModelIds = new Set(installedCatalogIds);
      const ollamaSelected = aiSetupConfig?.ollamaSelectedModelIds ?? aiSetupConfig?.selectedModels ?? [];
      const modelsToPull = ollamaSelected.filter((id) => !availablePreferenceModelIds.has(id));
      const preferenceModels = (tracked: TrackedModel[]): PreferenceModels => ({
        model: preferenceModelId(aiSetupConfig?.preferredModelId, availablePreferenceModelIds, tracked),
        embeddingModel: preferenceModelId(aiSetupConfig?.preferredEmbeddingModelId, availablePreferenceModelIds, tracked),
        visionModel: preferenceModelId(aiSetupConfig?.preferredVisionModelId, availablePreferenceModelIds, tracked),
      });
      // What the last save stored, so the download polling can correct it.
      let savedModels: PreferenceModels | null = null;
      // The tracked-models read before the installs. The download polling takes it as its first round.
      let trackedBeforeInstalls: TrackedModel[] | null = null;

      // ─── AI Setup Phase ───────────────────────────────────────────────
      // Runners, cloud keys, and preferences go before the app installs, because an AI app gets its
      // inference config when its install starts. The downloads are waited on after the installs
      // are requested. Waiting first left the apps unrequested when someone pressed Continue.
      if (aiSetupConfig && !aiSetupConfig.skipped) {
        let automaticRunnerUrls = new Map<string, string>();
        const automaticRunners = automaticRunnersForBackend(aiSetupConfig.backend);

        // A reload already ran runner setup and cloud keys. Doing either again would install
        // the runners twice, or overwrite a saved key with the blank this session stores.
        if (!resume) {
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
            } catch (error) {
              setAiPhase((prev) => ({
                ...prev,
                error: `${t('ONBOARDING_INFERENCE_RUNNERS_FAILED')} ${describePullStartError(error)}`,
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
        }

        let latestTracked: TrackedModel[] = [];
        if (modelsToPull.length > 0) {
          // A chosen model that has arrived, or is still arriving, is kept as a default; one that
          // failed or never started is not (see preferenceModelId).
          try {
            latestTracked = await withTimeout(fetchTrackedModels(), REQUEST_TIMEOUT_MS);
            trackedBeforeInstalls = latestTracked;
          } catch {
            // Decide from what is installed. A failed read must not hold up the installs.
          }
          for (const id of parsePullProgress(modelsToPull, installedCatalogIds, latestTracked).pulledIds) {
            availablePreferenceModelIds.add(id);
          }
        }

        const configuredOrAutomaticUrl = (configured: string | undefined, runner: string) =>
          configured?.trim() || automaticRunnerUrls.get(runner) || null;

        try {
          const models = preferenceModels(latestTracked);
          await saveInferencePreferences({
            backend: aiSetupConfig.backend,
            ...models,
            // A resumed session stored these blank. Passing null would clear the key the first
            // pass already saved. Leaving them out keeps what is on disk.
            vllmApiKey: resume ? undefined : (aiSetupConfig.vllmApiKey ?? null),
            vllmUrl: resume ? undefined : configuredOrAutomaticUrl(aiSetupConfig.vllmUrl, 'vllm'),
            omlxUrl: resume ? undefined : configuredOrAutomaticUrl(aiSetupConfig.omlxUrl, 'omlx'),
            decodeEndpoint: resume ? undefined : (aiSetupConfig.decodeEndpoint ?? null),
            encodeEndpoint: resume ? undefined : (aiSetupConfig.encodeEndpoint ?? null),
          });
          savedModels = models;
        } catch {
          setAiPhase((prev) => ({ ...prev, error: t('ONBOARDING_INSTALL_FAILED_SAVE_PREFERRED_BACKEND', { status: 0 }) }));
        }
      }

      // ─── App Install Phase ────────────────────────────────────────────
      const finalStates: AppInstallState[] = apps.map((app) => ({ app, status: 'queued' as AppInstallStatus }));
      const stateAt = (index: number, app: OnboardingApp): AppInstallState => finalStates[index] ?? { app, status: 'queued' };

      const fetchInstalledStatusMap = async (): Promise<Map<string, 'running' | 'installing' | 'install_failed'>> => {
        try {
          const installedResult = await withTimeout(sdkResult(getInstalledApps()), REQUEST_TIMEOUT_MS);
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

      const alreadyInstalled = await fetchInstalledStatusMap();

      const enqueueApp = async (index: number, app: OnboardingApp) => {
        if (!app.urn) {
          finalStates[index] = { ...stateAt(index, app), status: 'failed', error: t('ONBOARDING_APP_NOT_AVAILABLE_IN_STORE') };
          setStates([...finalStates]);
          return;
        }

        const known = alreadyInstalled.get(app.urn);
        // Claimed on an earlier load, or already on the Hub. Asking again starts a second install,
        // or a start, of the one that is already underway.
        if (known || preexistingClaims.has(app.urn)) {
          const status = known === 'running' ? 'running' : known === 'install_failed' ? 'failed' : 'installing';
          finalStates[index] = {
            ...stateAt(index, app),
            status,
            error: status === 'failed' ? t('ONBOARDING_INSTALL_FAILED_RETRY_MY_APPS') : undefined,
          };
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
          releaseOnboardingInstallUrn(app.urn);
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

      // ─── Model Downloads ──────────────────────────────────────────────
      // Followed for as long as the step is open. A large model takes longer than any fixed wait, and a
      // download the step stopped watching read "Queued" and then failed its pin.
      const downloadAndPin = async (setup: AiSetupConfig) => {
        const modelErrors: Record<string, string> = {};
        const modelProgress: Record<string, number> = Object.fromEntries(installedCatalogIds.map((id) => [id, 100]));
        const pinFailures: Record<string, string> = {};
        const hubRefusals = new Map<string, string>();
        const pinsAsked = new Set<string>();
        let pins = Promise.resolve();

        const publishPins = () => {
          const ordered: Record<string, string> = {};
          for (const id of ollamaSelected) {
            const reason = pinFailures[id];
            if (reason) ordered[id] = reason;
          }
          const refusals = [...hubRefusals.values()];
          const pinRefusal = refusals.length > 1 && new Set(refusals).size === 1 ? refusals[0] : undefined;
          setAiPhase((prev) => ({ ...prev, pinFailures: ordered, pinRefusal }));
        };

        // One pin at a time, in the order the downloads land, because the Hub checks each against the
        // pinned-model budget the earlier ones used. A slow pin holds up the next pin, not the polling.
        const pin = (modelId: string) => {
          if (pinsAsked.has(modelId)) return;
          pinsAsked.add(modelId);
          delete pinFailures[modelId];
          pins = pins.then(async () => {
            if (cancelled()) return;
            try {
              await pinInferenceModel(modelId);
            } catch (pinError) {
              const refusal = (pinError as Error)?.message;
              if (refusal) hubRefusals.set(modelId, refusal);
              pinFailures[modelId] = refusal || t('ONBOARDING_PIN_FAILED');
              publishPins();
            }
          });
        };

        /*
         * ⚠ A MODEL THE ENGINE HAS IS PINNABLE WHETHER OR NOT THIS HUB TRACKS IT. The Hub tracks a
         * model once it pulls or loads one, in memory. After a reset, a reinstall or a restart that
         * list is empty while every model is still in Ollama, so pinning only tracked models pinned
         * nothing. The row showed its check mark anyway. `installedCatalogIds` is the engine's
         * own list from when the wizard opened. The Hub's pin loads a model that is on disk
         * but untracked (`InferenceRouterService.pinTrackedModel`).
         */
        const pinWhatIsOnDisk = (tracked: TrackedModel[]) => {
          const onDisk = new Set([...installedCatalogIds, ...tracked.filter(isOnDisk).map((m) => m.catalogId)]);
          for (const modelId of ollamaSelected) {
            if (onDisk.has(modelId)) pin(modelId);
          }
        };

        // A failed save is not tried again with the same models, so a Hub that refuses it is not asked every second.
        let lastTried = savedModels;
        const savePreferences = async (next: PreferenceModels) => {
          if (!savedModels || samePreferences(next, savedModels) || (lastTried && samePreferences(next, lastTried))) return;
          lastTried = next;
          try {
            // Only the defaults: leaving the URLs and keys out keeps what the first save stored.
            await withTimeout(saveInferencePreferences({ backend: setup.backend, ...next }), REQUEST_TIMEOUT_MS);
            savedModels = next;
          } catch {
            // The last save stands.
          }
        };

        type Settled = { tracked: TrackedModel[]; pulledIds: Set<string> };
        const takeRound = async (tracked: TrackedModel[]): Promise<Settled | null> => {
          const parsed = parsePullProgress(modelsToPull, installedCatalogIds, tracked);
          const failedNow: Record<string, string> = { ...parsed.errorsById };
          // A download the Hub refused to start is never tracked. The onboarding page heard the refusal.
          for (const id of modelsToPull) {
            const refusal = pullErrorsRef.current?.[id];
            if (refusal && !failedNow[id] && !tracked.some((m) => m.catalogId === id)) failedNow[id] = refusal;
          }
          const failedBefore = Object.keys(modelErrors).length;
          Object.assign(modelProgress, parsed.progressById);
          Object.assign(modelErrors, failedNow);
          const failed = Object.keys(modelErrors).length;
          setAiPhase((prev) => ({
            ...prev,
            modelProgress: { ...modelProgress },
            modelErrors: { ...modelErrors },
            ...(failed > failedBefore ? { error: t('ONBOARDING_INSTALL_MODEL_DOWNLOADS_FAILED', { count: failed }) } : {}),
          }));
          if (failed > failedBefore) {
            for (const modelId of Object.keys(modelErrors)) {
              if (!pinsAsked.has(modelId) && !pinFailures[modelId]) pinFailures[modelId] = t('ONBOARDING_PIN_NOT_DOWNLOADED');
            }
            publishPins();
          }
          pinWhatIsOnDisk(tracked);
          for (const id of parsed.pulledIds) {
            availablePreferenceModelIds.add(id);
          }

          if (modelsToPull.every((id) => parsed.pulledIds.has(id) || failedNow[id])) return { tracked, pulledIds: parsed.pulledIds };

          /*
           * The Hub pulls one model at a time and tracks the rest only when their turn comes, so the save
           * before the installs dropped a choice still queued. Store it once it is pulling. A choice is only
           * ever added here: one whose download failed is dropped once the downloads have settled.
           */
          if (savedModels) {
            const now = preferenceModels(tracked);
            await savePreferences({
              model: savedModels.model ?? now.model,
              embeddingModel: savedModels.embeddingModel ?? now.embeddingModel,
              visionModel: savedModels.visionModel ?? now.visionModel,
            });
          }
          return null;
        };

        setAiPhase((prev) => ({ ...prev, status: modelsToPull.length > 0 ? 'pulling-models' : 'pinning-models' }));
        pinWhatIsOnDisk([]);

        const watchStart = Date.now();
        // The read before the installs is the first round. The next one waits an interval.
        let tracked: TrackedModel[] | null = trackedBeforeInstalls;
        let settled: Settled | null = null;
        while (modelsToPull.length > 0) {
          if (!tracked) {
            try {
              tracked = await withTimeout(fetchTrackedModels(), REQUEST_TIMEOUT_MS);
            } catch {
              // Asked again next round. A Hub that restarts mid-download answers once it is back.
            }
            if (cancelled()) return;
          }
          if (tracked) {
            settled = await takeRound(tracked);
            if (cancelled()) return;
            if (settled) break;
          }
          tracked = null;
          await minDelay(Date.now() - watchStart >= SLOW_POLL_AFTER_MS ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
          if (cancelled()) return;
        }

        // Store what the downloads ended as, which drops a choice whose download failed.
        if (settled) await savePreferences(preferenceModels(settled.tracked));

        setAiPhase((prev) => ({ ...prev, status: 'pinning-models' }));
        // A chosen model the step never saw land is named, so the row does not check a pin that did not happen.
        for (const modelId of ollamaSelected) {
          if (!pinsAsked.has(modelId) && !pinFailures[modelId]) {
            pinFailures[modelId] = modelErrors[modelId] ? t('ONBOARDING_PIN_NOT_DOWNLOADED') : t('ONBOARDING_PIN_STILL_DOWNLOADING');
          }
        }
        await pins;
        if (cancelled()) return;
        publishPins();
      };

      const followModels = async () => {
        if (!aiSetupConfig || aiSetupConfig.skipped || cancelled()) return;
        try {
          if (aiSetupConfig.selectedModels.length > 0) await downloadAndPin(aiSetupConfig);
        } catch {
          // Only something unexpected lands here. The pin row then says the pins were not attempted.
        }
        if (cancelled()) return;
        setAiPhase((prev) => ({ ...prev, status: 'done', modelsDone: true }));
      };

      // ─── App Status ───────────────────────────────────────────────────
      const refreshInstalledApps = () => {
        try {
          queryClient.invalidateQueries({ queryKey: getInstalledAppsQueryKey() });
          queryClient.invalidateQueries({ queryKey: appContextQueryKey() });
        } catch (_e) {
          // ignore
        }
      };
      const unsettled = (state: AppInstallState) => !!state.app.urn && (state.status === 'installing' || state.status === 'incomplete');

      // Followed for as long as the step is open. On a slow machine (Docker Desktop on a Mac) an app can
      // outlast the confirm window, and its row still has to turn Running or Failed when the Hub says so.
      const followApps = async () => {
        const followStart = Date.now();
        while (finalStates.some(unsettled)) {
          const statusMap = await fetchInstalledStatusMap();
          if (cancelled()) return;
          const overdue = Date.now() - followStart >= APP_CONFIRM_WINDOW_MS;
          let changed = false;
          let settledNow = false;

          for (let index = 0; index < finalStates.length; index++) {
            const state = finalStates[index];
            if (!state?.app.urn || !unsettled(state)) continue;
            const confirmed = statusMap.get(state.app.urn);
            if (confirmed === 'running') {
              finalStates[index] = { ...state, status: 'running', error: undefined };
              settledNow = true;
            } else if (confirmed === 'install_failed') {
              finalStates[index] = { ...state, status: 'failed', error: t('ONBOARDING_INSTALL_FAILED_RETRY_MY_APPS') };
              settledNow = true;
            } else if (overdue && state.status === 'installing') {
              finalStates[index] = { ...state, status: 'incomplete', error: t('ONBOARDING_INSTALL_STARTED_NOT_CONFIRMED') };
            } else {
              continue;
            }
            changed = true;
          }

          if (changed) setStates([...finalStates]);
          if (!finalStates.some(unsettled)) break;
          if (settledNow) refreshInstalledApps();
          // An app past the confirm window can take many minutes more, so it is asked about less often.
          await minDelay(overdue ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
          if (cancelled()) return;
        }
        refreshInstalledApps();
      };

      // The title says Installation Complete once every app is running or failed and every download has settled.
      await Promise.all([followModels(), followApps()]);
      if (cancelled()) return;
      setDone(true);
    };

    void installAll();
  }, [apps, defaultExposureMode, operatorUsername, resume, start]);

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

  const aiStatusLabel = (state: 'waiting' | 'working' | 'done' | 'failed') => {
    switch (state) {
      case 'failed':
        return t('COMMON_FAILED');
      case 'done':
        return t('COMMON_RUNNING');
      case 'working':
        return t('ONBOARDING_INSTALL_STATUS_INSTALLING');
      case 'waiting':
        return t('ONBOARDING_INSTALL_STATUS_QUEUED');
    }
  };

  const aiMark = (state: 'waiting' | 'working' | 'done' | 'failed', label = aiStatusLabel(state)) => (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="w-4 text-center">
        {state === 'failed' ? '✕' : state === 'done' ? '✓' : state === 'working' ? '●' : '○'}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  );

  const modelMark = (modelId: string): 'waiting' | 'working' | 'done' | 'failed' =>
    aiPhase.modelErrors[modelId]
      ? 'failed'
      : (aiPhase.modelProgress[modelId] ?? 0) >= 100
        ? 'done'
        : aiPhase.status === 'pulling-models'
          ? 'working'
          : 'waiting';

  // "Running" fits a runner. A model row says where its download is.
  const modelLabel = (state: 'waiting' | 'working' | 'done' | 'failed') =>
    state === 'done'
      ? t('ONBOARDING_INSTALL_STATUS_DOWNLOADED')
      : state === 'working'
        ? t('ONBOARDING_INSTALL_STATUS_DOWNLOADING')
        : aiStatusLabel(state);

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
  // The models the pin step asks for. A host-served model (vLLM, oMLX) is the server's to keep loaded.
  const pinnableSelection = aiSetupConfig?.ollamaSelectedModelIds ?? aiSetupConfig?.selectedModels ?? [];
  const pinFailureEntries = Object.entries(aiPhase.pinFailures ?? {});
  // A check mark only for pins that happened: a step that ended before the pins, or a pin that was
  // refused or skipped, is marked failed and says which model and why. Each model is pinned when its
  // download lands, so the row is in progress until the last download settles.
  const pinMark: 'waiting' | 'working' | 'done' | 'failed' =
    aiPhase.status === 'pulling-models' || aiPhase.status === 'pinning-models'
      ? 'working'
      : aiPhase.status === 'done'
        ? aiPhase.pinFailures && pinFailureEntries.length === 0
          ? 'done'
          : 'failed'
        : 'waiting';
  const aiInProgress = hasAiWork && aiPhase.status !== 'done';
  const unavailableRunners = aiPhase.runnerResults.filter((result) => result.state === 'failed' || result.state === 'skipped');
  const unavailableRunnerCount = unavailableRunners.length;

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

    if (processedCount < apps.length) {
      return t('ONBOARDING_INSTALLING_PROGRESS', { current: processedCount + 1, total: apps.length });
    }

    // Each app is past "Installing", and the step still waits on a download or on an app not yet confirmed.
    return `${summaryParts.join(', ')}.`;
  })();

  const hasAppWork = !done && states.some((s) => s.status === 'queued' || s.status === 'installing' || s.status === 'incomplete');
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
          <h2 className="text-lg font-medium tracking-tight sm:text-xl">
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
          <div
            className="h-2 rounded-full bg-primary transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* AI Setup Phase */}
      {start && aiPhase.status !== 'skipped' && (
        <div className="mb-4 space-y-1" data-testid="ai-phase-section">
          <div className="text-xs font-medium text-muted-foreground   mb-2">{t('ONBOARDING_AI_SETUP')}</div>
          {canAutoInstallRunners && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm" data-testid="inference-runners-phase">
              {aiMark(
                aiPhase.runnerResults.length > 0
                  ? aiPhase.runnerResults.some((result) => result.state === 'failed')
                    ? 'failed'
                    : 'done'
                  : aiPhase.status === 'installing-runners'
                    ? 'working'
                    : 'waiting',
              )}
              <span className="flex-1">{t('ONBOARDING_INFERENCE_RUNNERS')}</span>
              {unavailableRunnerCount > 0 && (
                <span className="text-xs text-warning">{t('ONBOARDING_INFERENCE_RUNNERS_UNAVAILABLE', { count: unavailableRunnerCount })}</span>
              )}
            </div>
          )}
          {canAutoInstallRunners &&
            unavailableRunners
              .filter((result) => result.detail)
              .map((result) => (
                <FailureLog
                  key={result.runner}
                  text={result.detail as string}
                  className="px-3 pb-1 pl-9 text-xs text-warning"
                  testId="inference-runner-reason"
                />
              ))}
          {aiSetupConfig?.cloudProviders && aiSetupConfig.cloudProviders.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
              {aiMark(aiPhase.cloudConfigured ? 'done' : aiPhase.status === 'configuring-cloud' ? 'working' : 'waiting')}
              <span>{t('ONBOARDING_CLOUD_PROVIDERS_CONFIGURED')}</span>
            </div>
          )}
          {aiSetupConfig?.selectedModels.map((modelId) => (
            <div key={modelId} className="flex items-center gap-2 px-3 py-1.5 text-sm" data-testid={`model-row-${modelId}`}>
              {aiMark(modelMark(modelId), modelLabel(modelMark(modelId)))}
              <span className="flex-1">
                {modelId}
                {modelId === aiSetupConfig.preferredModelId && <span className="ml-2 text-xs text-primary">{t('ONBOARDING_AGENT_DEFAULT')}</span>}
              </span>
              {aiPhase.modelErrors[modelId] ? (
                <span className="text-xs text-destructive max-w-[200px] truncate" title={aiPhase.modelErrors[modelId]}>
                  {t('ONBOARDING_SKIPPED')}
                </span>
              ) : (
                modelMark(modelId) === 'working' &&
                (aiPhase.modelProgress[modelId] ?? 0) > 0 && (
                  <span className="text-xs text-muted-foreground">{`${aiPhase.modelProgress[modelId]}%`}</span>
                )
              )}
            </div>
          ))}
          {aiPhase.error && (
            <div className="px-3 py-1 text-xs text-warning" data-testid="ai-phase-warning">
              {aiPhase.error}
            </div>
          )}
          {pinnableSelection.length > 0 && (
            <div className="px-3 py-1.5 text-sm" data-testid="pin-models-row">
              <div className="flex items-center gap-2">
                {aiMark(pinMark)}
                <span>{t('ONBOARDING_PIN_MODELS')}</span>
              </div>
              {pinFailureEntries.length > 0 && (
                <div className="ml-6 mt-1 space-y-0.5 text-xs text-destructive" data-testid="pin-models-failures">
                  {aiPhase.pinRefusal && <p data-testid="pin-models-refusal">{aiPhase.pinRefusal}</p>}
                  <ul className="space-y-0.5">
                    {pinFailureEntries.map(([modelId, reason]) => (
                      <li key={modelId}>
                        {reason === aiPhase.pinRefusal
                          ? t('ONBOARDING_PIN_NOT_PINNED_SAME_REASON', { model: modelId })
                          : t('ONBOARDING_PIN_NOT_PINNED', { model: modelId, reason })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {pinMark === 'failed' && !aiPhase.pinFailures && (
                <p className="ml-6 mt-1 text-xs text-destructive" data-testid="pin-models-failures">
                  {t('ONBOARDING_PIN_NOT_ATTEMPTED')}
                </p>
              )}
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
            <span className="w-5 h-5 flex items-center justify-center text-sm font-medium">{statusIcon(state.status)}</span>
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
              const continuedInBackground = hasAppWork || aiInProgress;
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
