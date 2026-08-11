import {
  fetchConfiguredCloudProviders,
  fetchInferenceOnboardingProfile,
  fetchInferencePreferences,
  fetchInferenceRuntimeModels,
  fetchInferenceTrackedModels,
  fetchOllamaInstallStatus,
  fetchVllmInstallStatus,
  pinInferenceModel,
  rescanInferenceHardware,
  saveCloudProviderConfig,
  saveInferencePreferences,
  unpinInferenceModel,
} from '@/lib/inference/inference-api';
import { POLLING } from '@/lib/polling-budget';
import { ensurePullsStarted, waitForModelPulls } from '@/lib/inference/tracked-models';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { RefreshCw, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import toast from 'react-hot-toast';
import type { CloudProviderInput, HardwareProfileResponse, RuntimeModelInfo } from '@/modules/onboarding/helpers/ai-setup-types';
import type { CuratedModel, InferenceBackendType, TrackedModel } from '@ci-hub/common/types';
import { SystemOverview } from '@/modules/onboarding/components/ai-setup/system-overview';
import { BackendSelectionCard } from '@/modules/onboarding/components/ai-setup/backend-selection-card';
import { CloudProviderCard } from '@/modules/onboarding/components/ai-setup/cloud-provider-card';
import { ResourceSummaryBar } from '@/modules/onboarding/components/ai-setup/resource-summary-bar';
import { ModelCard } from '@/modules/onboarding/components/ai-setup/primitives';
import { ModelIcon } from '@/modules/onboarding/components/ai-setup/icons';
import { modelTags, modelMeta, modelScores } from '@/modules/onboarding/components/ai-setup/model-selection-card';
import { OtherModelsSection } from '@/modules/onboarding/components/ai-setup/model-selection-card';
import { VllmSetupCard } from '@/modules/onboarding/components/ai-setup/vllm-setup-card';
import { OllamaSetupCard } from '@/modules/onboarding/components/ai-setup/ollama-setup-card';
import type { OllamaStatus, VllmStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { EMBEDDING_INFERENCE_BACKEND, unavailableInferenceBackends } from '@/modules/onboarding/helpers/inference-backend-availability';
import { useTranslation } from 'react-i18next';

// Role classifiers — mirror the onboarding AI-setup step so settings resolves the same defaults.
// Only LLMs can be the agent default; embeddings / speech models must never become the chat model.
const isAgentModel = (model: CuratedModel) => model.modality === 'llm';
const isEmbeddingModel = (model: CuratedModel) => model.modality === 'embedding';
const isVisionModel = (model: CuratedModel) => model.modality === 'llm' && model.metadata?.capabilities?.vision === true;

// Tracked states that mean "this model is on its way in, or already here".
const TRACKED_SELECTED_STATES = ['pulling', 'pulled', 'loading', 'loaded', 'pinned'];

// The models a save for `backend` actually acts on: same-backend models, plus Ollama embeddings
// (chat on vLLM still embeds through Ollama). Shared by the save itself and by the confirmation
// copy, so the dialog can never describe a different outcome than the one that will happen.
const isCompatibleWithBackend = (model: CuratedModel, backend: InferenceBackendType) =>
  model.backend === backend || (model.backend === EMBEDDING_INFERENCE_BACKEND && isEmbeddingModel(model));

const compatibleSelection = (profile: HardwareProfileResponse, backend: InferenceBackendType, selectedIds: string[]): string[] => {
  const availableModelById = new Map(profile.availableModels.map((model) => [model.id, model]));
  return selectedIds.filter((modelId) => {
    const model = availableModelById.get(modelId);
    return model ? isCompatibleWithBackend(model, backend) : false;
  });
};

// Pick the preferred model for a role from the user's selection, preferring a recommended model.
// Returns null (which clears the stored preference) when no selected model fits the role.
const resolvePreferredModelId = (
  profile: HardwareProfileResponse,
  backend: InferenceBackendType,
  match: (model: CuratedModel) => boolean,
  selectedIds: string[],
): string | null => {
  const selectedSet = new Set(selectedIds);
  const recommended = profile.recommendedModels.find((m) => m.backend === backend && match(m) && selectedSet.has(m.id));
  if (recommended) return recommended.id;
  return profile.availableModels.find((m) => m.backend === backend && match(m) && selectedSet.has(m.id))?.id ?? null;
};

export const AiSettingsContainer = () => {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const rocmSectionRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<HardwareProfileResponse | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<InferenceBackendType>('ollama');
  const [cloudProviders, setCloudProviders] = useState<CloudProviderInput[]>([]);
  const [pinnedModelIds, setPinnedModelIds] = useState<Set<string>>(new Set());
  const [trackedModels, setTrackedModels] = useState<Record<string, TrackedModel>>({});
  const [runtimeModels, setRuntimeModels] = useState<RuntimeModelInfo[]>([]);
  const [runtimeModelsLoading, setRuntimeModelsLoading] = useState(false);
  const [runtimeDiscoveryUnavailable, setRuntimeDiscoveryUnavailable] = useState(false);
  const [vllmApiKey, setVllmApiKey] = useState('');
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [vllmStatus, setVllmStatus] = useState<VllmStatus | null>(null);
  const [checkingOllama, setCheckingOllama] = useState(false);
  const [checkingVllm, setCheckingVllm] = useState(false);
  // Whether any agent default is currently stored — i.e. whether a save that resolves the roles to
  // null would actually destroy something. Refreshed by `fetchProfile`, which a save re-runs.
  const [hasStoredModelPreference, setHasStoredModelPreference] = useState(false);
  const suppressBackendEffectRef = useRef(true);

  // Records the transfer/pin state the Hub is tracking. Deliberately does NOT touch the selection:
  // the pull poller below lands here every few seconds, and rewriting the checkboxes from under the
  // operator would revert anything they ticked while a transfer was running. Seeding is a separate,
  // explicit step — see `seedSelectionFromInstalled`.
  const applyTrackedModels = useCallback((tracked: TrackedModel[]) => {
    setTrackedModels(Object.fromEntries(tracked.map((model) => [model.catalogId, model])));
    setPinnedModelIds(new Set(tracked.filter((model) => model.state === 'pinned').map((model) => model.catalogId)));
  }, []);

  // Seed the checkboxes from what the backend actually serves — the same source onboarding uses —
  // then add anything this process is mid-transfer on.
  //
  // The tracked registry can only ever ADD here, never define the set. It lives in a Map in the Hub
  // process and nothing rebuilds it at startup, so seeding from it alone showed every installed
  // model unticked after a restart (and for vLLM models, which the Hub never pulls at all). Saving
  // from that state cleared the stored chat/embedding/vision defaults and unpinned every model.
  const seedSelectionFromInstalled = useCallback((data: HardwareProfileResponse, backend: InferenceBackendType, tracked: TrackedModel[]) => {
    const installed = new Set(data.installedCatalogIds ?? []);
    // Same predicate the save uses. Seeding on a narrower rule would leave a model that the save
    // still acts on permanently unselected, which is the destructive shape this fix exists to close.
    const selected = new Set(
      data.availableModels.filter((model) => installed.has(model.id) && isCompatibleWithBackend(model, backend)).map((model) => model.id),
    );
    for (const model of tracked) {
      if (TRACKED_SELECTED_STATES.includes(model.state)) selected.add(model.catalogId);
    }
    setSelectedModelIds([...selected]);
  }, []);

  const fetchTrackedModels = useCallback(async () => {
    const tracked = await fetchInferenceTrackedModels();
    applyTrackedModels(tracked);
    return tracked;
  }, [applyTrackedModels]);

  const fetchRuntimeModels = useCallback(async (backend: InferenceBackendType) => {
    setRuntimeModelsLoading(true);
    try {
      const runtimeData = await fetchInferenceRuntimeModels(backend);
      setRuntimeModels(runtimeData.models);
      setRuntimeDiscoveryUnavailable(runtimeData.discoveryUnavailable);
    } catch {
      setRuntimeModels([]);
      setRuntimeDiscoveryUnavailable(true);
    } finally {
      setRuntimeModelsLoading(false);
    }
  }, []);

  const fetchProfile = async (isRescan = false, backendOverride?: InferenceBackendType) => {
    if (!isRescan) setLoading(true);
    setError(null);
    try {
      // Preferences first. The profile endpoint computes `installedCatalogIds` for whichever backend
      // it is asked about and falls back to the *hardware recommendation* when asked about none —
      // so fetching before the operator's stored backend is known returns the installed set for a
      // backend this panel may not be showing. That is what left the model checkboxes describing one
      // backend while the rest of the screen acted on another. Never throws; returns null instead.
      const prefData = await fetchInferencePreferences();
      if (prefData?.preferredVllmApiKey) {
        setVllmApiKey(prefData.preferredVllmApiKey);
      }
      setHasStoredModelPreference(Boolean(prefData?.preferredModel || prefData?.preferredEmbeddingModel || prefData?.preferredVisionModel));
      const requestedBackend = backendOverride ?? prefData?.preferredBackend ?? undefined;
      const data = await fetchInferenceOnboardingProfile(requestedBackend);
      setProfile(data);

      const preferredBackend = requestedBackend ?? data.backends.recommended;
      // fetchProfile handles initial runtime model fetch to avoid duplicate effect calls.
      suppressBackendEffectRef.current = true;
      setSelectedBackend(preferredBackend);

      const tracked = await fetchTrackedModels();
      seedSelectionFromInstalled(data, preferredBackend, tracked);
      await fetchRuntimeModels(preferredBackend);
      void checkOllamaStatus();
      if (preferredBackend === 'vllm') {
        void checkVllmStatus();
      }

      const configured = await fetchConfiguredCloudProviders();
      if (configured.length > 0) {
        setCloudProviders(configured);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (!isRescan) setLoading(false);
      setRescanning(false);
    }
  };

  const checkOllamaStatus = async () => {
    setCheckingOllama(true);
    try {
      setOllamaStatus((await fetchOllamaInstallStatus()) as OllamaStatus);
    } catch {
      setOllamaStatus({ ready: false, running: false, endpointUrl: '' });
    } finally {
      setCheckingOllama(false);
    }
  };

  const checkVllmStatus = useCallback(async () => {
    setCheckingVllm(true);
    try {
      setVllmStatus((await fetchVllmInstallStatus()) as VllmStatus);
    } catch {
      setVllmStatus({ ready: false, running: false, endpointUrl: '' });
    } finally {
      setCheckingVllm(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount
  useEffect(() => {
    fetchProfile();
  }, []);

  useEffect(() => {
    if (searchParams.get('section') !== 'rocm' || loading) return;
    rocmSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [loading, searchParams]);

  const handleRescan = async () => {
    setRescanning(true);
    try {
      await rescanInferenceHardware();
      await fetchProfile(true);
    } catch (e) {
      toast.error(t('AI_SETTINGS_RESCAN_FAILED', { error: (e as Error).message }));
      setRescanning(false);
    }
  };

  const handleToggleModel = (modelId: string) => {
    setSelectedModelIds((prev) => (prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId]));
  };

  // Refresh profile + runtime models whenever user changes inference backend in settings.
  useEffect(() => {
    if (!profile) return;
    if (suppressBackendEffectRef.current) {
      suppressBackendEffectRef.current = false;
      return;
    }
    void fetchInferenceOnboardingProfile(selectedBackend).then(setProfile);
    fetchRuntimeModels(selectedBackend);
    if (selectedBackend === 'vllm') {
      void checkVllmStatus();
    }
  }, [selectedBackend, fetchRuntimeModels, profile, checkVllmStatus]);

  const hasActiveTransfers = Object.values(trackedModels).some((model) => ['pulling', 'loading', 'unloading'].includes(model.state));

  useEffect(() => {
    if (!saving && !hasActiveTransfers) return;

    void fetchTrackedModels();
    const intervalId = window.setInterval(() => {
      void fetchTrackedModels();
    }, POLLING.MODEL_PULL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchTrackedModels, hasActiveTransfers, saving]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (!profile) {
        toast.error(t('AI_SETTINGS_PROFILE_NOT_READY'));
        return;
      }

      const availableModelById = new Map(profile.availableModels.map((model) => [model.id, model]));
      const compatibleSelectedModelIds = compatibleSelection(profile, selectedBackend, selectedModelIds);

      const preferredModel = resolvePreferredModelId(profile, selectedBackend, isAgentModel, compatibleSelectedModelIds);
      const preferredEmbeddingModel = resolvePreferredModelId(profile, EMBEDDING_INFERENCE_BACKEND, isEmbeddingModel, compatibleSelectedModelIds);
      const preferredVisionModel = resolvePreferredModelId(profile, selectedBackend, isVisionModel, compatibleSelectedModelIds);

      await saveInferencePreferences({
        backend: selectedBackend,
        model: preferredModel,
        embeddingModel: preferredEmbeddingModel,
        visionModel: preferredVisionModel,
        vllmApiKey: selectedBackend === 'vllm' ? vllmApiKey.trim() || null : null,
      });

      // Save cloud providers — for already-configured providers (masked key),
      // always persist enabled state; for new/changed keys, send the full config.
      for (const cp of cloudProviders) {
        if (cp.apiKey.trim() && !cp.apiKey.startsWith('••')) {
          await saveCloudProviderConfig({ provider: cp.provider, apiKey: cp.apiKey, enabled: cp.enabled });
        } else if (cp.apiKey.startsWith('••')) {
          await saveCloudProviderConfig({ provider: cp.provider, enabled: cp.enabled });
        }
      }

      const ollamaSelectedModelIds = compatibleSelectedModelIds.filter((modelId) => availableModelById.get(modelId)?.backend === 'ollama');
      const compatiblePinnedModelIds = [...pinnedModelIds].filter((modelId) => availableModelById.get(modelId)?.backend === 'ollama');
      const modelOperationErrors: string[] = [];
      const modelsToPull = ollamaSelectedModelIds.filter((modelId) => !compatiblePinnedModelIds.includes(modelId));

      if (modelsToPull.length > 0) {
        await ensurePullsStarted(modelsToPull, false);

        const pullResult = await waitForModelPulls(modelsToPull, profile.installedCatalogIds ?? [], { timeoutMs: 600_000 });
        for (const [modelId, message] of Object.entries(pullResult.errorsById)) {
          modelOperationErrors.push(`Failed to pull ${modelId}: ${message}`);
        }

        for (const modelId of modelsToPull) {
          if (pullResult.errorsById[modelId]) continue;
          if (!pullResult.pulledIds.has(modelId) && pullResult.progressById[modelId] !== 100) {
            modelOperationErrors.push(`Failed to pull ${modelId}: timed out`);
            continue;
          }

          try {
            await pinInferenceModel(modelId);
          } catch (e) {
            modelOperationErrors.push(`Failed to pin ${modelId}: ${(e as Error).message}`);
          }
        }
      }

      // Unpin models that were deselected
      for (const modelId of compatiblePinnedModelIds) {
        if (!compatibleSelectedModelIds.includes(modelId)) {
          try {
            await unpinInferenceModel(modelId);
          } catch (e) {
            modelOperationErrors.push(`Failed to unpin ${modelId}: ${(e as Error).message}`);
          }
        }
      }

      if (modelOperationErrors.length > 0) {
        toast.success(t('AI_SETTINGS_SAVED_WITH_ISSUES', { count: modelOperationErrors.length }));
      } else {
        toast.success(t('AI_SETTINGS_SAVED'));
      }
      // Refresh to show updated state
      await fetchProfile(true);
    } catch (e) {
      toast.error(t('AI_SETTINGS_SAVE_FAILED', { message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <div className="rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t('COMMON_DETECTING_HARDWARE')}</p>
          </div>
          <div className="space-y-4 mt-2">
            <Skeleton className="h-40 w-full rounded-md" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton count never changes
                <Skeleton key={`sk-${i}`} className="h-40 w-full rounded-md" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="space-y-5">
        <div className="rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6 text-center py-8">
          <p className="text-destructive mb-4">{t('AI_SETTINGS_LOAD_FAILED', { error: String(error) })}</p>
          <Button variant="outline" onClick={() => fetchProfile()}>
            <RefreshCw className="mr-2" size={16} />
            {t('COMMON_RETRY')}
          </Button>
        </div>
      </div>
    );
  }

  const isInsufficient = profile.tier === 'insufficient';
  const backendCompatibleRecommendedModels = profile.recommendedModels.filter((model) => isCompatibleWithBackend(model, selectedBackend));
  const backendAvailableModels = profile.availableModels.filter((model) => isCompatibleWithBackend(model, selectedBackend));
  const selectedModels = backendAvailableModels.filter((model) => selectedModelIds.includes(model.id));
  const availableStorageMb = profile.resourceEstimate.availableDiskMb ?? 0;
  const availableMemoryMb = profile.resourceEstimate.availableMemoryMb ?? 0;
  const installedCatalogIds = profile.installedCatalogIds ?? [];

  // Saving with nothing selected for the active backend is the destructive shape: every role
  // resolves to null, which clears the stored chat/embedding/vision defaults, and every pinned
  // model is unpinned. Legitimate when meant — so it stays possible — but the generic "this will
  // restart your apps" copy gives no hint of it, which is how it got triggered by accident.
  //
  // Gated on there being something to actually lose, not on models being installed. Keying it to
  // the installed list would go quiet in precisely the case that needs it most: a backend that is
  // down answers the profile endpoint with nothing served, so the selection empties for a reason
  // that has nothing to do with intent. Stored preferences and pins are the things a save destroys,
  // and `pinnedModelIds` is the same set the unpin loop walks, so this cannot warn about a pin the
  // save would not touch — nor stay silent about one it would.
  const saveClearsModelPreferences =
    compatibleSelection(profile, selectedBackend, selectedModelIds).length === 0 && (hasStoredModelPreference || pinnedModelIds.size > 0);

  return (
    <div className="space-y-5">
      {/* Hardware overview — same component as FTUE */}
      <div ref={rocmSectionRef}>
        <SystemOverview
          hardware={profile.hardware}
          tier={profile.tier}
          onRescan={handleRescan}
          rescanning={rescanning}
          availableDiskMb={profile.resourceEstimate.availableDiskMb}
          diskTotalMb={profile.resourceEstimate.diskTotalMb}
        />
      </div>

      {!isInsufficient && (
        <>
          {/* Recommended Models — FTUE ModelCard grid */}
          <section className="rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
            <h2 className="text-base font-bold uppercase tracking-wide">{t('COMMON_RECOMMENDED_MODELS')}</h2>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 mb-5">{t('AI_SETTINGS_RECOMMENDED_MODELS_SUBTITLE')}</p>

            {backendCompatibleRecommendedModels.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('AI_SETTINGS_NO_RECOMMENDED_MODELS')}</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {backendCompatibleRecommendedModels.map((model) => {
                  const isSelected = selectedModelIds.includes(model.id);
                  const tracked = trackedModels[model.id];
                  const statusBadge = (() => {
                    if (!tracked) return null;
                    if (tracked.state === 'pulling' && typeof tracked.pullProgress === 'number')
                      return {
                        text: t('AI_SETTINGS_DOWNLOADING_PROGRESS', { progress: tracked.pullProgress }),
                        cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
                      };
                    if (tracked.state === 'pinned')
                      return { text: t('AI_SETTINGS_PINNED_BADGE'), cls: 'border-primary/30 bg-primary/10 text-primary' };
                    if (tracked.state === 'pulled' || tracked.state === 'loaded')
                      return {
                        text: t('AI_SETTINGS_DOWNLOADED_BADGE'),
                        cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
                      };
                    return {
                      text: tracked.state.charAt(0).toUpperCase() + tracked.state.slice(1),
                      cls: 'border-border bg-foreground/5 text-muted-foreground',
                    };
                  })();
                  return (
                    <div key={model.id} className="relative">
                      <ModelCard
                        testId={`model-row-${model.id}`}
                        checkboxTestId={`recommended-model-checkbox-${model.id}`}
                        title={model.displayName}
                        icon={<ModelIcon model={model} />}
                        tags={modelTags(model, t)}
                        selected={isSelected}
                        onToggle={() => handleToggleModel(model.id)}
                        meta={modelMeta(model)}
                        scores={modelScores(model)}
                      />
                      {statusBadge && (
                        <span
                          className={`absolute top-3 right-9 text-[10px] px-1.5 py-0.5 rounded-md border font-medium pointer-events-none ${statusBadge.cls}`}
                        >
                          {statusBadge.text}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Other installable models */}
            {backendAvailableModels.length > backendCompatibleRecommendedModels.length && (
              <div className="mt-4">
                <OtherModelsSection
                  recommendedModels={backendCompatibleRecommendedModels}
                  availableModels={backendAvailableModels}
                  installedCatalogIds={installedCatalogIds}
                  selectedModelIds={selectedModelIds}
                  onToggleModel={handleToggleModel}
                />
              </div>
            )}
          </section>

          {/* Downloaded Models */}
          <section className="rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
            <h2 className="text-base font-bold uppercase tracking-wide mb-0.5">{t('AI_SETTINGS_DOWNLOADED_MODELS')}</h2>
            <p className="text-xs text-muted-foreground mb-4">{t('AI_SETTINGS_DOWNLOADED_MODELS_SUBTITLE')}</p>

            {runtimeModelsLoading && <p className="text-sm text-muted-foreground">{t('SETTINGS_NETWORK_LOADING')}</p>}

            {!runtimeModelsLoading && runtimeDiscoveryUnavailable && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-400">
                {t('AI_SETTINGS_RUNTIME_DISCOVERY_UNAVAILABLE')}
              </div>
            )}

            {!runtimeModelsLoading && !runtimeDiscoveryUnavailable && runtimeModels.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('AI_SETTINGS_NO_ACTIVE_MODELS')}</p>
            )}

            {!runtimeModelsLoading && runtimeModels.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {runtimeModels.map((model) => (
                  <div key={model.id} className="flex items-center gap-3 rounded-md border border-border bg-foreground/[0.015] p-4">
                    <span className="flex-shrink-0 text-foreground/60 [&>*]:size-8">
                      <ModelIcon model={{ id: model.id, displayName: model.name, modality: 'llm', metadata: undefined }} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{model.name}</div>
                      <div className="text-[11px] text-muted-foreground uppercase tracking-wide truncate">{model.id}</div>
                    </div>
                    <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-medium">
                      {t('AI_SETTINGS_DOWNLOADED_BADGE')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <BackendSelectionCard
            recommended={profile.backends.recommended}
            available={profile.backends.available}
            selected={selectedBackend}
            onSelect={setSelectedBackend}
            unavailableTypes={profile ? unavailableInferenceBackends(profile) : ['vllm', 'lemonade']}
          />

          {selectedBackend === 'vllm' && (
            <section className="rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6 space-y-4">
              <div>
                <h2 className="text-base font-bold uppercase tracking-wide">{t('ONBOARDING_VLLM_SECTION_TITLE')}</h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{t('ONBOARDING_VLLM_SECTION_DESC')}</p>
              </div>
              <VllmSetupCard
                status={vllmStatus}
                checking={checkingVllm}
                onRecheck={checkVllmStatus}
                apiKey={vllmApiKey}
                onApiKeyChange={setVllmApiKey}
              />
              <div>
                <h3 className="text-sm font-semibold">{t('ONBOARDING_EMBEDDINGS_OLLAMA_SECTION_TITLE')}</h3>
                <p className="text-xs text-muted-foreground mt-0.5 mb-3">{t('ONBOARDING_EMBEDDINGS_OLLAMA_SECTION_DESC')}</p>
                <OllamaSetupCard status={ollamaStatus} checking={checkingOllama} onRecheck={checkOllamaStatus} />
              </div>
            </section>
          )}

          <ResourceSummaryBar
            selectedModels={selectedModels}
            installedCatalogIds={installedCatalogIds}
            availableStorageMb={availableStorageMb}
            availableMemoryMb={availableMemoryMb}
          />
        </>
      )}

      <CloudProviderCard providers={cloudProviders} insufficientHardware={isInsufficient} onUpdate={setCloudProviders} />

      <div className="flex justify-end">
        <Button intent="primary" onClick={() => setConfirmOpen(true)} loading={saving} data-testid="ai-settings-save-btn">
          Save AI Settings
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{saveClearsModelPreferences ? t('AI_SETTINGS_CONFIRM_CLEAR_TITLE') : t('AI_SETTINGS_CONFIRM_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription data-testid="ai-settings-confirm-description">
            {saveClearsModelPreferences ? t('AI_SETTINGS_CONFIRM_CLEAR_DESCRIPTION') : t('AI_SETTINGS_CONFIRM_DESCRIPTION')}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} data-testid="ai-settings-cancel-btn">
              {t('COMMON_CANCEL')}
            </Button>
            <Button
              intent="primary"
              onClick={() => {
                setConfirmOpen(false);
                void handleSave();
              }}
              data-testid="ai-settings-confirm-btn"
            >
              {t('COMMON_CONTINUE')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
