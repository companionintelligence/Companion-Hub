import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { RefreshCw, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import toast from 'react-hot-toast';
import type {
  CloudProviderInput,
  HardwareProfileResponse,
  InferencePreferencesResponse,
  RuntimeModelInfo,
  RuntimeModelsResponse,
} from '@/modules/onboarding/helpers/ai-setup-types';
import type { CloudProviderType, CuratedModel, InferenceBackendType, TrackedModel } from '@ci-hub/common/types';
import { SystemOverview } from '@/modules/onboarding/components/ai-setup/system-overview';
import { BackendSelectionCard } from '@/modules/onboarding/components/ai-setup/backend-selection-card';
import { CloudProviderCard } from '@/modules/onboarding/components/ai-setup/cloud-provider-card';
import { ResourceSummaryBar } from '@/modules/onboarding/components/ai-setup/resource-summary-bar';
import { ModelCard } from '@/modules/onboarding/components/ai-setup/primitives';
import { ModelIcon } from '@/modules/onboarding/components/ai-setup/icons';
import { modelTags, modelMeta, modelScores } from '@/modules/onboarding/components/ai-setup/model-selection-card';
import { OtherModelsSection } from '@/modules/onboarding/components/ai-setup/model-selection-card';
import { useTranslation } from 'react-i18next';

// Role classifiers — mirror the onboarding AI-setup step so settings resolves the same defaults.
// Only LLMs can be the agent default; embeddings / speech models must never become the chat model.
const isAgentModel = (model: CuratedModel) => model.modality === 'llm';
const isEmbeddingModel = (model: CuratedModel) => model.modality === 'embedding';
const isVisionModel = (model: CuratedModel) => model.modality === 'llm' && model.metadata?.capabilities?.vision === true;

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
  const suppressBackendEffectRef = useRef(true);

  const applyTrackedModels = useCallback((tracked: TrackedModel[]) => {
    const trackedById = Object.fromEntries(tracked.map((model) => [model.catalogId, model]));
    const pinned = new Set<string>();
    const selectedIds: string[] = [];

    for (const model of tracked) {
      if (['pulling', 'pulled', 'loading', 'loaded', 'pinned'].includes(model.state)) {
        selectedIds.push(model.catalogId);
      }
      if (model.state === 'pinned') {
        pinned.add(model.catalogId);
      }
    }

    setTrackedModels(trackedById);
    setPinnedModelIds(pinned);
    setSelectedModelIds(selectedIds);
  }, []);

  const fetchTrackedModels = useCallback(async () => {
    const trackedRes = await apiFetch('/api/inference/models/tracked');
    if (!trackedRes.ok) {
      applyTrackedModels([]);
      return [] as TrackedModel[];
    }

    const tracked: TrackedModel[] = await trackedRes.json();
    applyTrackedModels(tracked);
    return tracked;
  }, [applyTrackedModels]);

  const fetchRuntimeModels = useCallback(async (backend: InferenceBackendType) => {
    setRuntimeModelsLoading(true);
    try {
      const runtimeRes = await apiFetch(`/api/inference/models/runtime?backend=${encodeURIComponent(backend)}`);
      if (!runtimeRes.ok) {
        throw new Error(`HTTP ${runtimeRes.status}`);
      }

      const runtimeData: RuntimeModelsResponse = await runtimeRes.json();

      setRuntimeModels(runtimeData.models);
      setRuntimeDiscoveryUnavailable(runtimeData.discoveryUnavailable);
    } catch {
      setRuntimeModels([]);
      setRuntimeDiscoveryUnavailable(true);
    } finally {
      setRuntimeModelsLoading(false);
    }
  }, []);

  const fetchProfile = async (isRescan = false) => {
    if (!isRescan) setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/inference/onboarding-profile');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: HardwareProfileResponse = await res.json();
      setProfile(data);

      let preferredBackend = data.backends.recommended;
      const prefRes = await apiFetch('/api/inference/preferences');
      if (prefRes.ok) {
        const prefData: InferencePreferencesResponse = await prefRes.json();
        preferredBackend = prefData.preferredBackend ?? data.backends.recommended;
      }
      // fetchProfile handles initial runtime model fetch to avoid duplicate effect calls.
      suppressBackendEffectRef.current = true;
      setSelectedBackend(preferredBackend);

      await fetchTrackedModels();
      await fetchRuntimeModels(preferredBackend);

      // Load configured cloud providers
      const cloudRes = await apiFetch('/api/inference/cloud-providers');
      if (cloudRes.ok) {
        const providers = await cloudRes.json();
        const configured: CloudProviderInput[] = providers
          .filter((p: { configured: boolean }) => p.configured)
          .map((p: { provider: CloudProviderType; enabled: boolean }) => ({
            provider: p.provider,
            apiKey: '••••••••', // Don't expose the actual key
            enabled: p.enabled,
          }));
        if (configured.length > 0) {
          setCloudProviders(configured);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (!isRescan) setLoading(false);
      setRescanning(false);
    }
  };

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
      const res = await apiFetch('/api/inference/hardware/rescan', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchProfile(true);
    } catch (e) {
      toast.error(t('AI_SETTINGS_RESCAN_FAILED', { error: (e as Error).message }));
      setRescanning(false);
    }
  };

  const handleToggleModel = (modelId: string) => {
    setSelectedModelIds((prev) => (prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId]));
  };

  // Refresh runtime model list whenever user changes inference backend in settings.
  useEffect(() => {
    if (!profile) return;
    if (suppressBackendEffectRef.current) {
      suppressBackendEffectRef.current = false;
      return;
    }
    fetchRuntimeModels(selectedBackend);
  }, [selectedBackend, fetchRuntimeModels, profile]);

  const hasActiveTransfers = Object.values(trackedModels).some((model) => ['pulling', 'loading', 'unloading'].includes(model.state));

  useEffect(() => {
    if (!saving && !hasActiveTransfers) return;

    void fetchTrackedModels();
    const intervalId = window.setInterval(() => {
      void fetchTrackedModels();
    }, 2000);

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
      const compatibleSelectedModelIds = selectedModelIds.filter((modelId) => availableModelById.get(modelId)?.backend === selectedBackend);

      // Resolve the default model for each role from the user's selection so agents/RAG/vision
      // tasks have a usable default. null clears any previously stored preference for that role.
      const preferredModel = resolvePreferredModelId(profile, selectedBackend, isAgentModel, compatibleSelectedModelIds);
      const preferredEmbeddingModel = resolvePreferredModelId(profile, selectedBackend, isEmbeddingModel, compatibleSelectedModelIds);
      const preferredVisionModel = resolvePreferredModelId(profile, selectedBackend, isVisionModel, compatibleSelectedModelIds);

      const backendRes = await apiFetch('/api/inference/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backend: selectedBackend,
          model: preferredModel,
          embeddingModel: preferredEmbeddingModel,
          visionModel: preferredVisionModel,
        }),
      });
      if (!backendRes.ok) {
        throw new Error(`Failed to save preferred backend: HTTP ${backendRes.status}`);
      }

      // Save cloud providers — for already-configured providers (masked key),
      // always persist enabled state; for new/changed keys, send the full config.
      for (const cp of cloudProviders) {
        if (cp.apiKey.trim() && !cp.apiKey.startsWith('••')) {
          await apiFetch('/api/inference/cloud-providers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: cp.provider, apiKey: cp.apiKey, enabled: cp.enabled }),
          });
        } else if (cp.apiKey.startsWith('••')) {
          // Already-configured provider — update enabled state without re-sending key
          await apiFetch('/api/inference/cloud-providers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: cp.provider, enabled: cp.enabled }),
          });
        }
      }

      const compatiblePinnedModelIds = [...pinnedModelIds].filter((modelId) => availableModelById.get(modelId)?.backend === selectedBackend);
      const modelOperationErrors: string[] = [];

      // Pull and pin newly selected models
      for (const modelId of compatibleSelectedModelIds) {
        if (compatiblePinnedModelIds.includes(modelId)) {
          continue;
        }

        try {
          const pullRes = await apiFetch('/api/inference/models/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId }),
          });

          if (!pullRes.ok) {
            modelOperationErrors.push(`Failed to pull ${modelId}: HTTP ${pullRes.status}`);
            continue;
          }

          const pinRes = await apiFetch('/api/inference/models/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId }),
          });

          if (!pinRes.ok) {
            modelOperationErrors.push(`Failed to pin ${modelId}: HTTP ${pinRes.status}`);
          }
        } catch (e) {
          modelOperationErrors.push(`Failed to pull/pin ${modelId}: ${(e as Error).message}`);
        }
      }

      // Unpin models that were deselected
      for (const modelId of compatiblePinnedModelIds) {
        if (!compatibleSelectedModelIds.includes(modelId)) {
          try {
            const unpinRes = await apiFetch('/api/inference/models/unpin', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ modelId }),
            });
            if (!unpinRes.ok) {
              modelOperationErrors.push(`Failed to unpin ${modelId}: HTTP ${unpinRes.status}`);
            }
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
        <div className="rounded-3xl border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t('COMMON_DETECTING_HARDWARE')}</p>
          </div>
          <div className="space-y-4 mt-2">
            <Skeleton className="h-40 w-full rounded-2xl" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton count never changes
                <Skeleton key={`sk-${i}`} className="h-40 w-full rounded-2xl" />
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
        <div className="rounded-3xl border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6 text-center py-8">
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
  const backendCompatibleRecommendedModels = profile.recommendedModels.filter((model) => model.backend === selectedBackend);
  const backendAvailableModels = profile.availableModels.filter((model) => model.backend === selectedBackend);
  const selectedModels = backendAvailableModels.filter((model) => selectedModelIds.includes(model.id));
  const availableStorageMb = profile.resourceEstimate.availableDiskMb ?? 0;
  const availableMemoryMb = profile.resourceEstimate.availableMemoryMb ?? 0;
  const installedCatalogIds = profile.installedCatalogIds ?? [];

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
          <section className="rounded-3xl border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
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
          <section className="rounded-3xl border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
            <h2 className="text-base font-bold uppercase tracking-wide mb-0.5">{t('AI_SETTINGS_DOWNLOADED_MODELS')}</h2>
            <p className="text-xs text-muted-foreground mb-4">{t('AI_SETTINGS_DOWNLOADED_MODELS_SUBTITLE')}</p>

            {runtimeModelsLoading && <p className="text-sm text-muted-foreground">{t('SETTINGS_NETWORK_LOADING')}</p>}

            {!runtimeModelsLoading && runtimeDiscoveryUnavailable && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-400">
                {t('AI_SETTINGS_RUNTIME_DISCOVERY_UNAVAILABLE')}
              </div>
            )}

            {!runtimeModelsLoading && !runtimeDiscoveryUnavailable && runtimeModels.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('AI_SETTINGS_NO_ACTIVE_MODELS')}</p>
            )}

            {!runtimeModelsLoading && runtimeModels.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {runtimeModels.map((model) => (
                  <div key={model.id} className="flex items-center gap-3 rounded-2xl border border-border bg-foreground/[0.015] p-4">
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
            unavailableTypes={['vllm', 'lemonade']}
          />

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
            <DialogTitle>{t('AI_SETTINGS_CONFIRM_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription>{t('AI_SETTINGS_CONFIRM_DESCRIPTION')}</DialogDescription>
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
