import {
  fetchConfiguredCloudProviders,
  fetchInferenceOnboardingProfile,
  fetchInferencePreferences,
  fetchInferenceRuntimeModels,
  fetchInferenceTrackedModels,
  fetchLemonadeInstallStatus,
  fetchOllamaInstallStatus,
  fetchOmlxInstallStatus,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { CloudProviderInput, HardwareProfileResponse, RuntimeModelInfo } from '@/modules/onboarding/helpers/ai-setup-types';
import type { CuratedModel, InferenceBackendType, ModelState, TrackedModel } from '@ci-hub/common/types';
import { SystemOverview } from '@/modules/onboarding/components/ai-setup/system-overview';
import { BackendSelectionCard } from '@/modules/onboarding/components/ai-setup/backend-selection-card';
import { CloudProviderCard } from '@/modules/onboarding/components/ai-setup/cloud-provider-card';
import { ResourceSummaryBar } from '@/modules/onboarding/components/ai-setup/resource-summary-bar';
import { ModelCard } from '@/modules/onboarding/components/ai-setup/primitives';
import { ModelIcon } from '@/modules/onboarding/components/ai-setup/icons';
import { modelTags, modelMeta, modelScores } from '@/modules/onboarding/components/ai-setup/model-selection-card';
import { OtherModelsSection } from '@/modules/onboarding/components/ai-setup/model-selection-card';
import { VllmSetupCard } from '@/modules/onboarding/components/ai-setup/vllm-setup-card';
import { OmlxSetupCard } from '@/modules/onboarding/components/ai-setup/omlx-setup-card';
import { ManualEndpointsCard } from '@/modules/onboarding/components/ai-setup/manual-endpoints-card';
import { LemonadeSetupCard } from '@/modules/onboarding/components/ai-setup/lemonade-setup-card';
import { OllamaSetupCard } from '@/modules/onboarding/components/ai-setup/ollama-setup-card';
import type { LemonadeStatus, OmlxStatus, OllamaStatus, VllmStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import {
  EMBEDDING_INFERENCE_BACKEND,
  hubLoadableSelection,
  isHubLoadableBackend,
  hiddenInferenceBackends,
  unavailableInferenceBackends,
} from '@/modules/onboarding/helpers/inference-backend-availability';
import { useTranslation } from 'react-i18next';

// Role classifiers — mirror the onboarding AI-setup step so settings resolves the same defaults.
// Only LLMs can be the agent default; embeddings / speech models must never become the chat model.
const isAgentModel = (model: CuratedModel) => model.modality === 'llm';
const isEmbeddingModel = (model: CuratedModel) => model.modality === 'embedding';
const isVisionModel = (model: CuratedModel) => model.modality === 'llm' && model.metadata?.capabilities?.vision === true;

// Tracked states that mean "this model is on its way in, or already here". Typed against the state
// union so a state added to `ModelState` has to be considered here rather than silently excluded.
const TRACKED_SELECTED_STATES: ModelState[] = ['pulling', 'pulled', 'loading', 'loaded', 'pinned'];

// Share backend compatibility between saving and confirmation so the dialog cannot
// describe a different outcome. vLLM chat continues to use Ollama embeddings.
const isCompatibleWithBackend = (model: CuratedModel, backend: InferenceBackendType) =>
  model.backend === backend || (model.backend === EMBEDDING_INFERENCE_BACKEND && isEmbeddingModel(model));

type ModelIndex = Map<string, CuratedModel>;

const indexAvailableModels = (profile: HardwareProfileResponse): ModelIndex => new Map(profile.availableModels.map((model) => [model.id, model]));

const compatibleSelection = (availableModelById: ModelIndex, backend: InferenceBackendType, selectedIds: string[]): string[] =>
  selectedIds.filter((modelId) => {
    const model = availableModelById.get(modelId);
    return model ? isCompatibleWithBackend(model, backend) : false;
  });

// Limit confirmation and unpinning to Hub-loadable models so the dialog does not
// promise to remove pins that Save leaves untouched.
const unpinnablePins = (availableModelById: ModelIndex, pinnedIds: Iterable<string>): string[] =>
  [...pinnedIds].filter((modelId) => isHubLoadableBackend(availableModelById.get(modelId)?.backend));

// A null match does not clear the stored preference because serialization drops the
// undefined field. Preference-clearing UI must wait until the API carries explicit null.
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
  const [vllmUrl, setVllmUrl] = useState('');
  const [omlxUrl, setOmlxUrl] = useState('');
  const [decodeEndpoint, setDecodeEndpoint] = useState('');
  const [encodeEndpoint, setEncodeEndpoint] = useState('');
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [vllmStatus, setVllmStatus] = useState<VllmStatus | null>(null);
  const [omlxStatus, setOmlxStatus] = useState<OmlxStatus | null>(null);
  const [lemonadeStatus, setLemonadeStatus] = useState<LemonadeStatus | null>(null);
  const [checkingOllama, setCheckingOllama] = useState(false);
  const [checkingVllm, setCheckingVllm] = useState(false);
  const [checkingOmlx, setCheckingOmlx] = useState(false);
  const [checkingLemonade, setCheckingLemonade] = useState(false);
  // Backend the backend-switch effect has already refetched for (set by fetchProfile too, since it
  // fetches profile + runtime models itself); prevents a duplicate fetch right after mount.
  const lastHandledBackendRef = useRef<InferenceBackendType | null>(null);
  // Mirrors for values the stable callbacks / effects below need without retriggering on change.
  const vllmUrlRef = useRef('');
  vllmUrlRef.current = vllmUrl;
  const vllmApiKeyRef = useRef('');
  vllmApiKeyRef.current = vllmApiKey;
  const omlxUrlRef = useRef('');
  omlxUrlRef.current = omlxUrl;
  const decodeEndpointRef = useRef('');
  decodeEndpointRef.current = decodeEndpoint;
  const encodeEndpointRef = useRef('');
  encodeEndpointRef.current = encodeEndpoint;
  const trackedModelsRef = useRef<TrackedModel[]>([]);
  // Share one catalog index between Save and confirmation so they cannot disagree or
  // rebuild it independently.
  const availableModelById = useMemo<ModelIndex>(() => (profile ? indexAvailableModels(profile) : new Map()), [profile]);

  const applyTrackedModels = useCallback((tracked: TrackedModel[]) => {
    const trackedById = Object.fromEntries(tracked.map((model) => [model.catalogId, model]));
    const pinned = new Set<string>();

    for (const model of tracked) {
      if (model.state === 'pinned') {
        pinned.add(model.catalogId);
      }
    }

    trackedModelsRef.current = tracked;
    setTrackedModels(trackedById);
    setPinnedModelIds(pinned);
  }, []);

  /**
   * Seeds model selection from backend-installed and actively tracked models. The tracked
   * registry is process-local and misses externally loaded models (#1106).
   */
  const seedSelectedModelIds = useCallback((data: HardwareProfileResponse, backend: InferenceBackendType, tracked: TrackedModel[]) => {
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
      // Load preferences first because the profile's hardware fallback can compute installed
      // models for a backend other than the one shown in settings.
      const prefData = await fetchInferencePreferences();
      if (prefData?.preferredVllmApiKey) {
        setVllmApiKey(prefData.preferredVllmApiKey);
      }
      if (prefData?.preferredVllmUrl) {
        setVllmUrl(prefData.preferredVllmUrl);
      }
      if (prefData?.preferredOmlxUrl) {
        setOmlxUrl(prefData.preferredOmlxUrl);
      }
      if (prefData?.preferredDecodeEndpoint) {
        setDecodeEndpoint(prefData.preferredDecodeEndpoint);
      }
      if (prefData?.preferredEncodeEndpoint) {
        setEncodeEndpoint(prefData.preferredEncodeEndpoint);
      }
      const requestedBackend = backendOverride ?? prefData?.preferredBackend ?? undefined;
      const data = await fetchInferenceOnboardingProfile(requestedBackend);
      setProfile(data);

      const preferredBackend = requestedBackend ?? data.backends.recommended;
      // fetchProfile handles initial runtime model fetch to avoid duplicate effect calls.
      lastHandledBackendRef.current = preferredBackend;
      setSelectedBackend(preferredBackend);

      const tracked = await fetchTrackedModels();
      seedSelectedModelIds(data, preferredBackend, tracked);
      await fetchRuntimeModels(preferredBackend);
      void checkOllamaStatus();
      if (preferredBackend === 'vllm') {
        void checkVllmStatus();
      } else if (preferredBackend === 'omlx') {
        void checkOmlxStatus();
      } else if (preferredBackend === 'lemonade') {
        void checkLemonadeStatus();
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
      const data = (await fetchOllamaInstallStatus()) as OllamaStatus;
      setOllamaStatus(data);
      return data;
    } catch {
      setOllamaStatus({ ready: false, running: false, endpointUrl: '' });
      return null;
    } finally {
      setCheckingOllama(false);
    }
  };

  // Same stale-profile defect as the vLLM path (#1105): a model pulled outside the Hub only
  // surfaces after the profile's installedCatalogIds are recomputed.
  const handleRecheckOllama = async () => {
    const status = await checkOllamaStatus();
    if (status?.ready) {
      const data = await fetchInferenceOnboardingProfile(
        selectedBackend,
        selectedBackend === 'vllm' ? vllmUrlRef.current : undefined,
        selectedBackend === 'vllm' ? vllmApiKeyRef.current : undefined,
        selectedBackend === 'omlx' ? omlxUrlRef.current : undefined,
      );
      setProfile(data);
      seedSelectedModelIds(data, selectedBackend, trackedModelsRef.current);
    }
  };

  const checkVllmStatus = useCallback(async () => {
    setCheckingVllm(true);
    try {
      const data = (await fetchVllmInstallStatus(vllmUrlRef.current, vllmApiKeyRef.current)) as VllmStatus;
      setVllmStatus(data);
      return data;
    } catch {
      setVllmStatus({ ready: false, running: false, endpointUrl: '' });
      return null;
    } finally {
      setCheckingVllm(false);
    }
  }, []);

  // Refresh the profile because only its endpoint recomputes `installedCatalogIds`; a
  // status probe alone misses models served after page load (#1105).
  const handleRecheckVllm = useCallback(async () => {
    const status = await checkVllmStatus();
    if (status?.ready) {
      const data = await fetchInferenceOnboardingProfile('vllm', vllmUrlRef.current, vllmApiKeyRef.current);
      setProfile(data);
      seedSelectedModelIds(data, 'vllm', trackedModelsRef.current);
    }
  }, [checkVllmStatus, seedSelectedModelIds]);

  const checkOmlxStatus = useCallback(async () => {
    setCheckingOmlx(true);
    try {
      const data = (await fetchOmlxInstallStatus(omlxUrlRef.current)) as OmlxStatus;
      setOmlxStatus(data);
      return data;
    } catch {
      setOmlxStatus({ ready: false, running: false, endpointUrl: '' });
      return null;
    } finally {
      setCheckingOmlx(false);
    }
  }, []);

  const handleRecheckOmlx = useCallback(async () => {
    const status = await checkOmlxStatus();
    if (status?.ready) {
      const data = await fetchInferenceOnboardingProfile('omlx', undefined, undefined, omlxUrlRef.current);
      setProfile(data);
      seedSelectedModelIds(data, 'omlx', trackedModelsRef.current);
    }
  }, [checkOmlxStatus, seedSelectedModelIds]);

  const checkLemonadeStatus = useCallback(async () => {
    setCheckingLemonade(true);
    try {
      const data = await fetchLemonadeInstallStatus();
      setLemonadeStatus(data);
      return data;
    } catch {
      setLemonadeStatus({ ready: false, running: false, endpointUrl: '' });
      return null;
    } finally {
      setCheckingLemonade(false);
    }
  }, []);

  const handleRecheckLemonade = useCallback(async () => {
    const status = await checkLemonadeStatus();
    if (status?.ready) {
      const data = await fetchInferenceOnboardingProfile('lemonade');
      setProfile(data);
      seedSelectedModelIds(data, 'lemonade', trackedModelsRef.current);
    }
  }, [checkLemonadeStatus, seedSelectedModelIds]);

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

  // Keep `profile` out of the dependency list because the effect replaces it with a fresh
  // object; adding it causes an unbounded refetch loop (#1109).
  const hasProfileRef = useRef(false);
  hasProfileRef.current = profile !== null;

  // Refresh profile + runtime models whenever user changes inference backend in settings.
  useEffect(() => {
    if (!hasProfileRef.current) return;
    if (lastHandledBackendRef.current === selectedBackend) return;
    lastHandledBackendRef.current = selectedBackend;
    void fetchInferenceOnboardingProfile(
      selectedBackend,
      selectedBackend === 'vllm' ? vllmUrlRef.current : undefined,
      selectedBackend === 'vllm' ? vllmApiKeyRef.current : undefined,
      selectedBackend === 'omlx' ? omlxUrlRef.current : undefined,
    ).then((data) => {
      setProfile(data);
      // Re-seed the checkboxes for the new backend from server truth (see seedSelectedModelIds).
      seedSelectedModelIds(data, selectedBackend, trackedModelsRef.current);
    });
    fetchRuntimeModels(selectedBackend);
    if (selectedBackend === 'vllm') {
      void checkVllmStatus();
    } else if (selectedBackend === 'omlx') {
      void checkOmlxStatus();
    } else if (selectedBackend === 'lemonade') {
      void checkLemonadeStatus();
    }
  }, [selectedBackend, fetchRuntimeModels, checkVllmStatus, checkOmlxStatus, checkLemonadeStatus, seedSelectedModelIds]);

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

      const compatibleSelectedModelIds = compatibleSelection(availableModelById, selectedBackend, selectedModelIds);

      const preferredModel = resolvePreferredModelId(profile, selectedBackend, isAgentModel, compatibleSelectedModelIds);
      const embeddingBackend = selectedBackend === 'omlx' || selectedBackend === 'ollama' ? selectedBackend : EMBEDDING_INFERENCE_BACKEND;
      const preferredEmbeddingModel = resolvePreferredModelId(profile, embeddingBackend, isEmbeddingModel, compatibleSelectedModelIds);
      const preferredVisionModel = resolvePreferredModelId(profile, selectedBackend, isVisionModel, compatibleSelectedModelIds);

      // Cloud keys first so the debounced AI-app restart (from preferences) sees them.
      // Masked keys (`••••`) omit apiKey so the Hub keeps the stored secret.
      for (const cp of cloudProviders) {
        if (cp.apiKey.trim() && !cp.apiKey.startsWith('••')) {
          await saveCloudProviderConfig({ provider: cp.provider, apiKey: cp.apiKey, enabled: cp.enabled });
        } else if (cp.apiKey.startsWith('••')) {
          await saveCloudProviderConfig({ provider: cp.provider, enabled: cp.enabled });
        }
      }

      await saveInferencePreferences({
        backend: selectedBackend,
        model: preferredModel,
        embeddingModel: preferredEmbeddingModel,
        visionModel: preferredVisionModel,
        vllmApiKey: selectedBackend === 'vllm' ? vllmApiKey.trim() || null : null,
        vllmUrl: selectedBackend === 'vllm' ? vllmUrl.trim() || null : null,
        omlxUrl: selectedBackend === 'omlx' ? omlxUrl.trim() || null : null,
        decodeEndpoint: decodeEndpoint.trim() || null,
        encodeEndpoint: encodeEndpoint.trim() || null,
      });

      // Include every Hub-loadable backend so a saved preference cannot point to a selected
      // model that was never loaded.
      const pullableSelectedModelIds = hubLoadableSelection(
        compatibleSelectedModelIds,
        (modelId) => availableModelById.get(modelId)?.backend,
        preferredModel,
      );
      const compatiblePinnedModelIds = unpinnablePins(availableModelById, pinnedModelIds);
      const modelOperationErrors: string[] = [];
      const modelsToPull = pullableSelectedModelIds.filter((modelId) => !compatiblePinnedModelIds.includes(modelId));

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
      <div className="min-w-0 space-y-5">
        <div className="rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t('COMMON_DETECTING_HARDWARE')}</p>
          </div>
          <div className="space-y-4 mt-2">
            <Skeleton className="h-40 w-full rounded-md" />
            <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
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
      <div className="min-w-0 space-y-5">
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

  // The warning applies only when Save will unpin every managed model. A null
  // preferred-model result does not clear defaults, and unmanaged pins remain untouched.
  const saveUnpinsEveryModel =
    compatibleSelection(availableModelById, selectedBackend, selectedModelIds).length === 0 &&
    unpinnablePins(availableModelById, pinnedModelIds).length > 0;

  // Picked as a pair so the heading can never describe a different save than the body.
  const confirmCopy = saveUnpinsEveryModel
    ? { title: 'AI_SETTINGS_CONFIRM_UNPIN_TITLE', description: 'AI_SETTINGS_CONFIRM_UNPIN_DESCRIPTION' }
    : { title: 'AI_SETTINGS_CONFIRM_TITLE', description: 'AI_SETTINGS_CONFIRM_DESCRIPTION' };

  return (
    <div className="min-w-0 space-y-5">
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
              <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
                {backendCompatibleRecommendedModels.map((model) => {
                  const isSelected = selectedModelIds.includes(model.id);
                  const tracked = trackedModels[model.id];
                  const statusBadge = (() => {
                    if (!tracked) return null;
                    if (tracked.state === 'pulling' && typeof tracked.pullProgress === 'number')
                      return {
                        text: t('AI_SETTINGS_DOWNLOADING_PROGRESS', { progress: tracked.pullProgress }),
                        cls: 'border-warning/30 bg-warning/10 text-warning',
                      };
                    if (tracked.state === 'pinned')
                      return { text: t('AI_SETTINGS_PINNED_BADGE'), cls: 'border-primary/30 bg-primary/10 text-primary' };
                    if (tracked.state === 'pulled' || tracked.state === 'loaded')
                      return {
                        text: t('AI_SETTINGS_DOWNLOADED_BADGE'),
                        cls: 'border-success/30 bg-success/10 text-success',
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
              <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning">
                {t('AI_SETTINGS_RUNTIME_DISCOVERY_UNAVAILABLE')}
              </div>
            )}

            {!runtimeModelsLoading && !runtimeDiscoveryUnavailable && runtimeModels.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('AI_SETTINGS_NO_ACTIVE_MODELS')}</p>
            )}

            {!runtimeModelsLoading && runtimeModels.length > 0 && (
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
                {runtimeModels.map((model) => (
                  <div key={model.id} className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-foreground/[0.015] p-4">
                    <span className="flex-shrink-0 text-foreground/60 [&>*]:size-8">
                      <ModelIcon model={{ id: model.id, displayName: model.name, modality: 'llm', metadata: undefined }} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{model.name}</div>
                      {/*
                        Only show the id when it differs from the display name. Every backend's
                        `listModels()` sets both from the same string for models it has no catalog
                        entry for — ollama.backend.ts:263 maps `id: m.name, name: m.name` — so on a
                        stock Ollama host this printed the same tag twice on every card, with the
                        useful line truncating first.
                      */}
                      {model.id === model.name ? null : (
                        <div className="text-[11px] text-muted-foreground uppercase tracking-wide truncate">{model.id}</div>
                      )}
                    </div>
                    <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-md border border-success/30 bg-success/10 text-success font-medium">
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
            unavailableTypes={profile ? unavailableInferenceBackends(profile) : []}
            hiddenTypes={profile ? hiddenInferenceBackends(profile) : []}
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
                onRecheck={handleRecheckVllm}
                apiKey={vllmApiKey}
                onApiKeyChange={setVllmApiKey}
                endpointUrl={vllmUrl}
                onEndpointUrlChange={setVllmUrl}
              />
              <div>
                <h3 className="text-sm font-semibold">{t('ONBOARDING_EMBEDDINGS_OLLAMA_SECTION_TITLE')}</h3>
                <p className="text-xs text-muted-foreground mt-0.5 mb-3">{t('ONBOARDING_EMBEDDINGS_OLLAMA_SECTION_DESC')}</p>
                <OllamaSetupCard status={ollamaStatus} checking={checkingOllama} onRecheck={handleRecheckOllama} />
              </div>
            </section>
          )}

          {selectedBackend === 'omlx' && (
            <section className="rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6 space-y-4">
              <div>
                <h2 className="text-base font-bold uppercase tracking-wide">{t('ONBOARDING_OMLX_SECTION_TITLE')}</h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">{t('ONBOARDING_OMLX_SECTION_DESC')}</p>
              </div>
              <OmlxSetupCard
                status={omlxStatus}
                checking={checkingOmlx}
                onRecheck={handleRecheckOmlx}
                endpointUrl={omlxUrl}
                onEndpointUrlChange={setOmlxUrl}
              />
            </section>
          )}

          {selectedBackend === 'lemonade' && (
            <section className="space-y-4 rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
              <div>
                <h2 className="text-base font-bold uppercase tracking-wide">{t('ONBOARDING_LEMONADE_SECTION_TITLE')}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">{t('ONBOARDING_LEMONADE_SECTION_DESC')}</p>
              </div>
              <LemonadeSetupCard status={lemonadeStatus} checking={checkingLemonade} onRecheck={handleRecheckLemonade} />
              <div>
                <h3 className="text-sm font-semibold">{t('ONBOARDING_EMBEDDINGS_OLLAMA_SECTION_TITLE')}</h3>
                <p className="text-xs text-muted-foreground mt-0.5 mb-3">{t('ONBOARDING_EMBEDDINGS_OLLAMA_SECTION_DESC')}</p>
                <OllamaSetupCard status={ollamaStatus} checking={checkingOllama} onRecheck={handleRecheckOllama} />
              </div>
            </section>
          )}

          <ManualEndpointsCard
            decodeEndpoint={decodeEndpoint}
            encodeEndpoint={encodeEndpoint}
            onDecodeEndpointChange={setDecodeEndpoint}
            onEncodeEndpointChange={setEncodeEndpoint}
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
            <DialogTitle>{t(confirmCopy.title)}</DialogTitle>
          </DialogHeader>
          <DialogDescription data-testid="ai-settings-confirm-description">{t(confirmCopy.description)}</DialogDescription>
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
