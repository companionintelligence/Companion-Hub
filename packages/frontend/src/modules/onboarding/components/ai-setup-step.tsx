import {
  fetchInferenceOnboardingProfile,
  fetchLemonadeInstallStatus,
  fetchMtplxInstallStatus,
  fetchOllamaInstallStatus,
  fetchDsparkInstallStatus,
  fetchVllmInstallStatus,
  rescanInferenceHardware,
} from '@/lib/inference/inference-api';
import { openExternal } from '@/lib/helpers/open-external';
import { getTauriInvoke } from '@/lib/helpers/tauri-invoke';
import { installAndStartInferenceRunners, type AutomaticInferenceRunner } from '@/lib/inference/auto-inference-runners';
import { Button } from '@/components/ui/Button';
import { useEffect, useRef, useState } from 'react';
import {
  validateCloudKey,
  type AgentFramework,
  type AiSetupConfig,
  type CloudProviderInput,
  type ExposureMode,
  type HardwareProfileResponse,
  type MtplxStatus,
  type LemonadeStatus,
  type OllamaStatus,
  type VllmStatus,
  type DsparkStatus,
  type RemoteAccessMode,
} from '../helpers/ai-setup-types';
import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';
import { AgentFrameworkCard } from './ai-setup/agent-apps-card';
import { AccessMethodsCard } from './ai-setup/access-methods-card';
import { CompanionAppsCard } from './ai-setup/companion-apps-card';
import { StepSection } from './ai-setup/primitives';
import { BackendSelectionCard } from './ai-setup/backend-selection-card';
import { OtherModelsSection, RecommendedModels } from './ai-setup/model-selection-card';
import { AdvancedDrawers } from './ai-setup/advanced-drawers';
import { SystemOverview } from './ai-setup/system-overview';
import { ResourceSummaryBar } from './ai-setup/resource-summary-bar';
import { OllamaSetupCard } from './ai-setup/ollama-setup-card';
import { VllmSetupCard } from './ai-setup/vllm-setup-card';
import { MtplxSetupCard } from './ai-setup/mtplx-setup-card';
import { DsparkSetupCard } from './ai-setup/dspark-setup-card';
import { LemonadeSetupCard } from './ai-setup/lemonade-setup-card';
import { TailscaleSetupStep } from './tailscale-setup-step';
import { computeSelectionBudget } from '../helpers/onboarding-model-selection';
import {
  EMBEDDING_INFERENCE_BACKEND,
  hubLoadableSelection,
  hiddenInferenceBackends,
  isHostServedBackend,
  recommendedInferenceBackend,
  unavailableInferenceBackends,
} from '../helpers/inference-backend-availability';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Only LLMs qualify as agent defaults; generic purpose labels can also include
// embedding and speech models.
const isAgentModel = (model: CuratedModel) => model.modality === 'llm';
const isEmbeddingModel = (model: CuratedModel) => model.modality === 'embedding';
const isVisionModel = (model: CuratedModel) => model.modality === 'llm' && model.metadata?.capabilities?.vision === true;

interface AiSetupStepProps {
  onComplete?: (config: AiSetupConfig) => void;
  onSkip?: () => void;
  onBack?: () => void;
  /** Whether a Cloudflare tunnel is configured — seeds the default agent remote-access choice. */
  cloudflareAvailable?: boolean;
  /** Whether Tailscale is connected — seeds the default agent remote-access choice. */
  tailscaleAvailable?: boolean;
  /**
   * Enables single-page FTUE behavior by hiding navigation and emitting live
   * configuration through {@link onConfigChange}.
   */
  embedded?: boolean;
  onConfigChange?: (config: AiSetupConfig) => void;
  /** Extra sections rendered after Companion Memory (step 5) — e.g. Recommended Apps on the one-page form. */
  children?: React.ReactNode;
  /** Public exposure mode for Companion Memory apps. */
  publicExposureMode?: ExposureMode;
  onCompanionAppsChange?: (apps: import('../helpers/types').OnboardingApp[]) => void;
}

// Web is the default path for every Hub. Also seed Private VPN when Tailscale is already connected.
const defaultRemoteAccess = (_cloudflareAvailable: boolean, tailscaleAvailable: boolean): RemoteAccessMode[] => {
  const modes: RemoteAccessMode[] = ['cloudflare'];
  if (tailscaleAvailable) modes.push('tailscale');
  return modes;
};

// The app installer exposes each app under a single mode; derive that primary from the selection.
const primaryExposureMode = (remoteAccess: RemoteAccessMode[]): ExposureMode =>
  remoteAccess.includes('cloudflare') ? 'cloudflare' : remoteAccess.includes('tailscale') ? 'tailscale' : 'local';

const BackendSetupGroup = ({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) => (
  <div className="space-y-3" data-testid="selected-backend-setup">
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
    </div>
    {children}
  </div>
);

export const AiSetupStep = ({
  onComplete,
  onSkip,
  onBack,
  cloudflareAvailable = false,
  tailscaleAvailable = false,
  embedded = false,
  onConfigChange,
  children,
  publicExposureMode = 'local',
  onCompanionAppsChange,
}: AiSetupStepProps) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<HardwareProfileResponse | null>(null);
  const [agentFrameworks, setAgentFrameworks] = useState<AgentFramework[]>(['openclaw']);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [preferredModelId, setPreferredModelId] = useState<string | undefined>(undefined);
  const [remoteAccess, setRemoteAccess] = useState<RemoteAccessMode[]>(defaultRemoteAccess(cloudflareAvailable, tailscaleAvailable));
  const [cloudProviders, setCloudProviders] = useState<CloudProviderInput[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [vllmStatus, setVllmStatus] = useState<VllmStatus | null>(null);
  const [mtplxStatus, setMtplxStatus] = useState<MtplxStatus | null>(null);
  const [dsparkStatus, setDsparkStatus] = useState<DsparkStatus | null>(null);
  const [lemonadeStatus, setLemonadeStatus] = useState<LemonadeStatus | null>(null);
  const [checkingOllama, setCheckingOllama] = useState(false);
  const [checkingVllm, setCheckingVllm] = useState(false);
  const [checkingMtplx, setCheckingMtplx] = useState(false);
  const [checkingDspark, setCheckingDspark] = useState(false);
  const [checkingLemonade, setCheckingLemonade] = useState(false);
  const [vllmApiKey, setVllmApiKey] = useState('');
  const [vllmUrl, setVllmUrl] = useState('');
  const [mtplxUrl, setMtplxUrl] = useState('');
  const [dsparkUrl, setDsparkUrl] = useState('');
  const [selectedBackend, setSelectedBackend] = useState<InferenceBackendType>('ollama');

  // Stamp profile requests so slower responses cannot overwrite newer operator choices.
  const profileRequestId = useRef(0);
  // Refs preserve edits made while a profile refresh is awaiting its response.
  const selectedModelIdsRef = useRef(selectedModelIds);
  selectedModelIdsRef.current = selectedModelIds;
  const preferredModelIdRef = useRef(preferredModelId);
  preferredModelIdRef.current = preferredModelId;

  // Both agent frameworks share one default, so use the highest-ranked selected or
  // installable LLM instead of catalog order.
  const getDefaultPreferredModelId = (data: HardwareProfileResponse, backend: InferenceBackendType, selectedIds?: string[]): string | undefined => {
    const installed = new Set(data.installedCatalogIds ?? []);
    const selected = selectedIds ?? data.availableModels.filter((m) => m.backend === backend && installed.has(m.id)).map((m) => m.id);
    const fromSelected = selected.find((id) => {
      const model = data.availableModels.find((m) => m.id === id);
      return model && model.backend === backend && isAgentModel(model);
    });
    if (fromSelected) return fromSelected;

    const installableAgentIds = new Set(data.availableModels.filter((m) => m.backend === backend && isAgentModel(m)).map((m) => m.id));
    const topRecommended = data.recommendedModels.find((m) => m.backend === backend && isAgentModel(m) && installableAgentIds.has(m.id));
    return topRecommended?.id ?? data.availableModels.find((m) => m.backend === backend && isAgentModel(m))?.id;
  };

  const getDefaultPreferredAuxModelId = (
    data: HardwareProfileResponse,
    backend: InferenceBackendType,
    match: (model: CuratedModel) => boolean,
    selectedIds?: string[],
  ): string | undefined => {
    const installed = new Set(data.installedCatalogIds ?? []);
    const selected = selectedIds ?? data.availableModels.filter((m) => m.backend === backend && installed.has(m.id)).map((m) => m.id);
    const selectedSet = new Set(selected);
    const recommended = data.recommendedModels.find((m) => m.backend === backend && match(m) && selectedSet.has(m.id));
    if (recommended) return recommended.id;
    return data.availableModels.find((m) => m.backend === backend && match(m) && selectedSet.has(m.id))?.id;
  };

  // Pre-select models already present on the active backend (and Ollama embeddings when chat is vLLM).
  const getDefaultSelectedModelIds = (data: HardwareProfileResponse, backend: InferenceBackendType): string[] => {
    const installed = new Set(data.installedCatalogIds ?? []);
    return data.availableModels
      .filter((m) => {
        if (!installed.has(m.id)) return false;
        if (m.backend === backend) return true;
        return isHostServedBackend(backend) && m.backend === EMBEDDING_INFERENCE_BACKEND && isEmbeddingModel(m);
      })
      .map((m) => m.id);
  };

  const fetchProfile = async (isRescan = false, backendOverride?: InferenceBackendType) => {
    if (!isRescan) setLoading(true);
    setError(null);
    const requestId = ++profileRequestId.current;
    try {
      const backend = backendOverride ?? selectedBackend;
      const data = await fetchInferenceOnboardingProfile(backend, vllmUrl, backend === 'vllm' ? vllmApiKey : undefined, mtplxUrl, dsparkUrl);
      // Ignore superseded rescans so they cannot restore an earlier backend and its defaults.
      if (profileRequestId.current !== requestId) return;
      setProfile(data);
      const requestedBackend = backendOverride ?? recommendedInferenceBackend(data);
      const hiddenBackends = hiddenInferenceBackends(data);
      const resolvedBackend = hiddenBackends.includes(requestedBackend)
        ? (data.backends.available.find(({ type }) => !hiddenBackends.includes(type))?.type ?? 'ollama')
        : requestedBackend;
      setSelectedBackend(resolvedBackend);
      const defaultSelected = getDefaultSelectedModelIds(data, resolvedBackend);
      setSelectedModelIds(defaultSelected);
      setPreferredModelId(getDefaultPreferredModelId(data, resolvedBackend, defaultSelected));
    } catch (e) {
      // Same rule for the failure path: a newer request is already in flight and may well succeed,
      // so raising the error screen on its behalf would discard a setup that is about to be fine.
      if (profileRequestId.current !== requestId) return;
      setError((e as Error).message);
    } finally {
      // Clear flags even for superseded requests because backend selection does not own them;
      // otherwise its request ID change can strand the spinner.
      if (!isRescan) setLoading(false);
      setRescanning(false);
    }
  };

  // Ollama runs on the host (reached via host.docker.internal); this only checks reachability.
  // Returns the status it stored so callers can act on it without waiting for the state to land.
  const checkOllamaStatus = async (): Promise<OllamaStatus> => {
    setCheckingOllama(true);
    try {
      const data = (await fetchOllamaInstallStatus()) as OllamaStatus;
      setOllamaStatus(data);
      return data;
    } catch (_e) {
      // Silently fail - Ollama status is optional
      const unreachable: OllamaStatus = { ready: false, running: false, endpointUrl: '' };
      setOllamaStatus(unreachable);
      return unreachable;
    } finally {
      setCheckingOllama(false);
    }
  };

  const checkLemonadeStatus = async (): Promise<LemonadeStatus> => {
    setCheckingLemonade(true);
    try {
      const data = await fetchLemonadeInstallStatus();
      setLemonadeStatus(data);
      return data;
    } catch {
      const unreachable: LemonadeStatus = { ready: false, running: false, endpointUrl: '' };
      setLemonadeStatus(unreachable);
      return unreachable;
    } finally {
      setCheckingLemonade(false);
    }
  };

  const checkDsparkStatus = async (): Promise<DsparkStatus> => {
    setCheckingDspark(true);
    try {
      const data = await fetchDsparkInstallStatus(dsparkUrl);
      setDsparkStatus(data);
      return data;
    } catch {
      const unreachable: DsparkStatus = { ready: false, running: false, endpointUrl: '' };
      setDsparkStatus(unreachable);
      return unreachable;
    } finally {
      setCheckingDspark(false);
    }
  };

  const checkVllmStatus = async (): Promise<VllmStatus> => {
    setCheckingVllm(true);
    try {
      const data = (await fetchVllmInstallStatus(vllmUrl, vllmApiKey)) as VllmStatus;
      setVllmStatus(data);
      return data;
    } catch (_e) {
      const unreachable: VllmStatus = { ready: false, running: false, endpointUrl: '' };
      setVllmStatus(unreachable);
      return unreachable;
    } finally {
      setCheckingVllm(false);
    }
  };

  const checkMtplxStatus = async (): Promise<MtplxStatus> => {
    setCheckingMtplx(true);
    try {
      const data = (await fetchMtplxInstallStatus(mtplxUrl)) as MtplxStatus;
      setMtplxStatus(data);
      return data;
    } catch (_e) {
      const unreachable: MtplxStatus = { ready: false, running: false, endpointUrl: '' };
      setMtplxStatus(unreachable);
      return unreachable;
    } finally {
      setCheckingMtplx(false);
    }
  };

  // Re-check refreshes installed models without resetting in-progress choices. A status probe
  // alone leaves `installedCatalogIds` stale; unlike `fetchProfile`, this best-effort refresh
  // does not replace the step with an error.
  const refreshInstalledModels = async (backend: InferenceBackendType, endpointUrlOverride?: string) => {
    const requestId = ++profileRequestId.current;
    try {
      const previouslyInstalled = new Set(profile?.installedCatalogIds ?? []);
      const data = await fetchInferenceOnboardingProfile(
        backend,
        backend === 'vllm' && endpointUrlOverride ? endpointUrlOverride : vllmUrl,
        backend === 'vllm' ? vllmApiKey : undefined,
        backend === 'mtplx' && endpointUrlOverride ? endpointUrlOverride : mtplxUrl,
        backend === 'dspark' && endpointUrlOverride ? endpointUrlOverride : dsparkUrl,
      );
      // Drop superseded responses so refreshes cannot restore stale hardware or backend state.
      if (profileRequestId.current !== requestId) return;
      setProfile(data);

      const nextInstalled = new Set(data.installedCatalogIds ?? []);
      // Preserve earlier opt-outs while selecting newly detected models.
      const newlySelectable = getDefaultSelectedModelIds(data, backend).filter((id) => !previouslyInstalled.has(id));
      // Remove unavailable host-served models because selection budgeting would treat them
      // as pending downloads and could block Continue.
      const isStillSelectable = (id: string) => {
        const modelBackend = data.availableModels.find((m) => m.id === id)?.backend;
        return !isHostServedBackend(modelBackend) || nextInstalled.has(id);
      };
      const nextSelected = [...new Set([...selectedModelIdsRef.current, ...newlySelectable])].filter(isStillSelectable);
      setSelectedModelIds(nextSelected);

      // Replace a catalog-seeded default when the backend does not serve it, but preserve an
      // installed or explicitly selected default.
      const preferred = preferredModelIdRef.current;
      setPreferredModelId(
        preferred && (nextInstalled.has(preferred) || nextSelected.includes(preferred))
          ? preferred
          : getDefaultPreferredModelId(data, backend, nextSelected),
      );
    } catch (e) {
      // Keep the in-progress setup after a secondary refresh fails, but retain a diagnostic.
      console.warn('Re-check could not refresh the installed model list', e);
    }
  };

  // Mount probes cannot refresh because `selectedBackend` still has its initial value.
  const handleRecheck = async (probe: () => Promise<{ ready: boolean }>, setChecking: (checking: boolean) => void) => {
    const status = await probe();
    // Refresh only after a successful probe; a failed backend health check returns an empty
    // installed set and would erase valid selections.
    if (!status.ready) return;
    // Keep the control busy through the profile refresh to prevent racing requests.
    setChecking(true);
    try {
      await refreshInstalledModels(selectedBackend);
    } finally {
      setChecking(false);
    }
  };

  const handleVllmRecheck = () => handleRecheck(checkVllmStatus, setCheckingVllm);
  const handleDsparkRecheck = () => handleRecheck(checkDsparkStatus, setCheckingDspark);
  const handleOllamaRecheck = () => handleRecheck(checkOllamaStatus, setCheckingOllama);
  const handleMtplxRecheck = () => handleRecheck(checkMtplxStatus, setCheckingMtplx);
  const handleLemonadeRecheck = () => handleRecheck(checkLemonadeStatus, setCheckingLemonade);

  const handleAutoInstallRunner = async (runner: Extract<AutomaticInferenceRunner, 'dspark' | 'mtplx' | 'vllm'>) => {
    const results = await installAndStartInferenceRunners([runner]);
    const result = results.find((candidate) => candidate.runner === runner);
    if (!result || result.state === 'failed' || result.state === 'skipped') {
      throw new Error('The local runner could not be installed on this machine.');
    }

    const endpoint = result.endpointUrl;
    if (!endpoint) {
      throw new Error('The local runner did not return a reachable endpoint.');
    }

    if (runner === 'vllm') {
      setVllmUrl(endpoint);
      const status = (await fetchVllmInstallStatus(endpoint, vllmApiKey)) as VllmStatus;
      setVllmStatus(status);
      if (!status.ready) throw new Error('The local runner is still starting.');
    } else if (runner === 'mtplx') {
      setMtplxUrl(endpoint);
      const status = (await fetchMtplxInstallStatus(endpoint)) as MtplxStatus;
      setMtplxStatus(status);
      if (!status.ready) throw new Error('The local runner is still starting.');
    } else {
      setDsparkUrl(endpoint);
      const status = await fetchDsparkInstallStatus(endpoint);
      setDsparkStatus(status);
      if (!status.ready) throw new Error('The local runner is still starting.');
    }

    await refreshInstalledModels(runner, endpoint);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount
  useEffect(() => {
    void (async () => {
      await fetchProfile(false);
      await Promise.all([checkOllamaStatus(), checkVllmStatus(), checkMtplxStatus(), checkDsparkStatus(), checkLemonadeStatus()]);
    })();
  }, []);

  const handleRescan = async () => {
    setRescanning(true);
    try {
      await rescanInferenceHardware();
      await fetchProfile(true);
    } catch (e) {
      setError((e as Error).message);
      setRescanning(false);
    }
  };

  const handleSelectBackend = async (backend: InferenceBackendType) => {
    if (!profile || backend === selectedBackend) {
      return;
    }

    setSelectedBackend(backend);
    const requestId = ++profileRequestId.current;
    try {
      const data = await fetchInferenceOnboardingProfile(backend, vllmUrl, backend === 'vllm' ? vllmApiKey : undefined, mtplxUrl, dsparkUrl);
      // Ignore a slower response from an earlier backend choice.
      if (profileRequestId.current === requestId) {
        setProfile(data);
        const defaultSelected = getDefaultSelectedModelIds(data, backend);
        setSelectedModelIds(defaultSelected);
        setPreferredModelId(getDefaultPreferredModelId(data, backend, defaultSelected));
      }
    } catch (e) {
      if (profileRequestId.current === requestId) setError((e as Error).message);
    }
    if (backend === 'vllm') {
      void checkVllmStatus();
    } else if (backend === 'mtplx') {
      void checkMtplxStatus();
    } else if (backend === 'lemonade') {
      void checkLemonadeStatus();
    }
    if (backend === 'dspark') {
      void checkDsparkStatus();
    }
  };

  const handleToggleModel = (modelId: string) => {
    const model = profile?.availableModels.find((m) => m.id === modelId);
    if (!model) return;
    const installed = new Set(profile?.installedCatalogIds ?? []);
    // Host-served backends cannot hot-swap, so uninstalled models open their model page.
    // Hub-loadable backends remain selectable.
    if (isHostServedBackend(model?.backend) && !installed.has(modelId) && !selectedModelIds.includes(modelId)) {
      openExternal(`https://huggingface.co/${model.backendModelId}`);
      return;
    }

    const isRemoving = selectedModelIds.includes(modelId);
    const next = isRemoving ? selectedModelIds.filter((id) => id !== modelId) : [...selectedModelIds, modelId];
    setSelectedModelIds(next);
    const isAgent = profile?.availableModels.some((m) => m.id === modelId && m.backend === selectedBackend && isAgentModel(m)) ?? false;
    if (isRemoving && modelId === preferredModelId) {
      // The agent's preferred model was removed — fall back to another selected agent model.
      const fallback = profile?.availableModels.find((m) => m.backend === selectedBackend && isAgentModel(m) && next.includes(m.id))?.id;
      setPreferredModelId(fallback);
    } else if (!isRemoving && isAgent && !preferredModelId) {
      // First agent model added back — make it the preferred default.
      setPreferredModelId(modelId);
    }
  };

  // Agent frameworks are multi-select; deselecting all is allowed (run no agent, add one later).
  const toggleFramework = (framework: AgentFramework) => {
    setAgentFrameworks((prev) => (prev.includes(framework) ? prev.filter((f) => f !== framework) : [...prev, framework]));
  };

  // Remote access is multi-select and optional (empty = local-only).
  const toggleAccess = (mode: RemoteAccessMode) => {
    setRemoteAccess((prev) => (prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode]));
  };

  const buildConfig = (): AiSetupConfig | null => {
    if (!profile) return null;
    const backendCompatibleSelectedModels = profile.availableModels
      .filter(
        (model) =>
          selectedModelIds.includes(model.id) &&
          (model.backend === selectedBackend || (model.backend === EMBEDDING_INFERENCE_BACKEND && model.modality === 'embedding')),
      )
      .map((model) => model.id);
    const validProviders = cloudProviders.filter((p) => {
      if (!p.apiKey.trim()) return false;
      return !validateCloudKey(p.provider, p.apiKey);
    });

    const selectedModels = [...backendCompatibleSelectedModels];
    const installedCatalogIds = profile.installedCatalogIds ?? [];

    let installBlocked = false;
    let installBlockReason: string | undefined;

    // Selecting no models is allowed — users can add AI later from settings.

    const budget = computeSelectionBudget(
      profile.availableModels.filter((m) => selectedModels.includes(m.id)),
      installedCatalogIds,
      profile.resourceEstimate.availableDiskMb,
      profile.resourceEstimate.availableMemoryMb,
    );
    if (budget.overDisk) {
      installBlocked = true;
      installBlockReason = budget.diskReason;
    }

    const effectivePreferredModelId =
      preferredModelId && selectedModels.includes(preferredModelId)
        ? preferredModelId
        : selectedModels.find((id) => profile.availableModels.some((m) => m.id === id && isAgentModel(m)));
    const embeddingBackend = selectedBackend === 'lemonade' ? selectedBackend : EMBEDDING_INFERENCE_BACKEND;
    const effectivePreferredEmbeddingModelId = getDefaultPreferredAuxModelId(profile, embeddingBackend, isEmbeddingModel, selectedModels);
    const effectivePreferredVisionModelId = getDefaultPreferredAuxModelId(profile, selectedBackend, isVisionModel, selectedModels);

    return {
      agentFrameworks,
      selectedModels,
      // The historical field name represents every Hub-loadable model, including the one
      // resident mlx-dspark model.
      ollamaSelectedModelIds: hubLoadableSelection(
        selectedModels,
        (id) => profile.availableModels.find((m) => m.id === id)?.backend,
        effectivePreferredModelId,
      ),
      backend: selectedBackend,
      cloudProviders: validProviders,
      preferredModelId: effectivePreferredModelId,
      ...(effectivePreferredEmbeddingModelId ? { preferredEmbeddingModelId: effectivePreferredEmbeddingModelId } : {}),
      ...(effectivePreferredVisionModelId ? { preferredVisionModelId: effectivePreferredVisionModelId } : {}),
      remoteAccess,
      exposureMode: primaryExposureMode(remoteAccess),
      skipped: false,
      installedCatalogIds,
      installBlocked,
      installBlockReason,
      ...(selectedBackend === 'vllm' && vllmApiKey.trim() ? { vllmApiKey: vllmApiKey.trim() } : {}),
      ...(selectedBackend === 'vllm' && vllmUrl.trim() ? { vllmUrl: vllmUrl.trim() } : {}),
      ...(selectedBackend === 'mtplx' && mtplxUrl.trim() ? { mtplxUrl: mtplxUrl.trim() } : {}),
      ...(selectedBackend === 'dspark' && dsparkUrl.trim() ? { dsparkUrl: dsparkUrl.trim() } : {}),
    };
  };

  const handleContinue = () => {
    const config = buildConfig();
    if (!config) throw new Error(t('ONBOARDING_AI_PROFILE_UNAVAILABLE'));
    onComplete?.(config);
  };

  const handleSkip = () => {
    onSkip?.();
  };

  // In embedded (single-form) mode, surface the live config to the parent as the user edits it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: emit only when the config inputs change
  useEffect(() => {
    if (!embedded || !onConfigChange || !profile) return;
    const config = buildConfig();
    if (config) onConfigChange(config);
  }, [
    embedded,
    profile,
    agentFrameworks,
    selectedModelIds,
    preferredModelId,
    selectedBackend,
    remoteAccess,
    cloudProviders,
    vllmApiKey,
    vllmUrl,
    mtplxUrl,
    dsparkUrl,
    onConfigChange,
  ]);

  if (loading) {
    return (
      <div className="space-y-4 max-h-[66vh] overflow-y-auto pr-2" data-testid="ai-setup-loading">
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <Loader2 role="img" aria-label={t('COMMON_LOADING')} className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('COMMON_DETECTING_HARDWARE')}</p>
        </div>
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  if (error || !profile) {
    // Show bridge guidance only when the probe identifies that failure; profile requests
    // can fail for unrelated reasons.
    return (
      <div className="py-8" data-testid="ai-setup-error">
        <p className="text-destructive mb-4 text-center">
          {t('ONBOARDING_AI_SETUP_FAILED')}: {error}
        </p>
        {ollamaStatus?.bridgeUnreachable && ollamaStatus.hint && (
          <div className="mx-auto mb-4 max-w-2xl rounded-lg border border-warning/30 bg-warning/10 p-3">
            <div className="text-xs text-warning">{ollamaStatus.hint}</div>
            {ollamaStatus.remediationCommand && (
              <>
                <div className="mt-2 mb-1 text-xs font-medium text-warning">{t('ONBOARDING_OLLAMA_RUN_ON_HOST')}</div>
                <code className="block overflow-x-auto whitespace-pre rounded bg-warning/10 px-2 py-1.5 text-xs text-warning">
                  {ollamaStatus.remediationCommand}
                </code>
              </>
            )}
          </div>
        )}
        <div className="flex gap-2 justify-center">
          <Button
            variant="outline"
            onClick={() => {
              // Re-check the probe too, so the diagnostic above reflects the
              // current state after the operator applies the fix.
              void checkOllamaStatus();
              void fetchProfile();
            }}
          >
            {t('COMMON_RETRY')}
          </Button>
          <Button variant="ghost" onClick={handleSkip}>
            {t('ONBOARDING_SKIP_AI_SETUP')}
          </Button>
        </div>
      </div>
    );
  }

  const isInsufficient = profile.tier === 'insufficient';
  const backendRecommendedModels = profile.recommendedModels.filter(
    (model) => model.backend === selectedBackend || (model.backend === EMBEDDING_INFERENCE_BACKEND && model.modality === 'embedding'),
  );
  const backendAvailableModels = profile.availableModels.filter(
    (model) => model.backend === selectedBackend || (model.backend === EMBEDDING_INFERENCE_BACKEND && model.modality === 'embedding'),
  );
  const selectedModels = backendAvailableModels.filter((model) => selectedModelIds.includes(model.id));
  const installedCatalogIds = profile.installedCatalogIds ?? [];
  const availableDiskMb = profile.resourceEstimate.availableDiskMb;
  const diskTotalMb = profile.resourceEstimate.diskTotalMb;
  const availableMemoryMb = profile.resourceEstimate.availableMemoryMb;
  const needsOllamaForContinue = selectedBackend === 'ollama' && (ollamaStatus === null || !ollamaStatus.ready);
  const needsVllmForContinue = selectedBackend === 'vllm' && (vllmStatus === null || !vllmStatus.ready);
  const needsMtplxForContinue = selectedBackend === 'mtplx' && (mtplxStatus === null || !mtplxStatus.ready);
  const needsDsparkForContinue = selectedBackend === 'dspark' && (dsparkStatus === null || !dsparkStatus.ready);
  const needsLemonadeForContinue = selectedBackend === 'lemonade' && (lemonadeStatus === null || !lemonadeStatus.ready);
  const canAutoInstallRunners = getTauriInvoke() !== null;
  // Host-run backends leave embeddings on Ollama, so the co-install warning covers all of them.
  const ollamaEmbeddingsWarning = isHostServedBackend(selectedBackend) && ollamaStatus !== null && !ollamaStatus.ready && !checkingOllama;
  const showTailscaleSetup = remoteAccess.includes('tailscale');

  return (
    <div className={embedded ? 'space-y-5' : 'space-y-5 max-h-[66vh] overflow-y-auto pr-2'} data-testid="ai-setup-step">
      <SystemOverview
        hardware={profile.hardware}
        tier={profile.tier}
        onRescan={handleRescan}
        rescanning={rescanning}
        availableDiskMb={availableDiskMb}
        diskTotalMb={diskTotalMb}
      />

      {!isInsufficient && (
        <>
          <AccessMethodsCard
            remoteAccess={remoteAccess}
            onToggleAccess={toggleAccess}
            cloudflareAvailable={cloudflareAvailable}
            tailscaleAvailable={tailscaleAvailable}
            tailscaleSetup={showTailscaleSetup ? <TailscaleSetupStep embedded inline /> : undefined}
          />

          <AgentFrameworkCard frameworks={agentFrameworks} onToggleFramework={toggleFramework} />

          <StepSection
            number={3}
            badge="required"
            title={t('ONBOARDING_INFERENCE_SETUP_TITLE')}
            className="space-y-5"
            testId="inference-setup-section"
          >
            <div className="border-b border-border pb-5">
              <BackendSelectionCard
                recommended={recommendedInferenceBackend(profile)}
                available={profile.backends.available}
                selected={selectedBackend}
                onSelect={handleSelectBackend}
                embedded
                unavailableTypes={unavailableInferenceBackends(profile)}
                hiddenTypes={hiddenInferenceBackends(profile)}
              />
            </div>

            {selectedBackend === 'vllm' ? (
              <BackendSetupGroup title={t('ONBOARDING_VLLM_SECTION_TITLE')} description={t('ONBOARDING_VLLM_SECTION_DESC')}>
                <VllmSetupCard
                  status={vllmStatus}
                  checking={checkingVllm}
                  onRecheck={handleVllmRecheck}
                  apiKey={vllmApiKey}
                  onApiKeyChange={setVllmApiKey}
                  endpointUrl={vllmUrl}
                  onEndpointUrlChange={setVllmUrl}
                  onAutoInstall={canAutoInstallRunners ? () => handleAutoInstallRunner('vllm') : undefined}
                />
              </BackendSetupGroup>
            ) : selectedBackend === 'mtplx' ? (
              <BackendSetupGroup title={t('ONBOARDING_MTPLX_SECTION_TITLE')} description={t('ONBOARDING_MTPLX_SECTION_DESC')}>
                <MtplxSetupCard
                  status={mtplxStatus}
                  checking={checkingMtplx}
                  onRecheck={handleMtplxRecheck}
                  endpointUrl={mtplxUrl}
                  onEndpointUrlChange={setMtplxUrl}
                  onAutoInstall={canAutoInstallRunners ? () => handleAutoInstallRunner('mtplx') : undefined}
                />
              </BackendSetupGroup>
            ) : selectedBackend === 'dspark' ? (
              <BackendSetupGroup title={t('ONBOARDING_DSPARK_SECTION_TITLE')} description={t('ONBOARDING_DSPARK_SECTION_DESC')}>
                <DsparkSetupCard
                  status={dsparkStatus}
                  checking={checkingDspark}
                  onRecheck={handleDsparkRecheck}
                  endpointUrl={dsparkUrl}
                  onEndpointUrlChange={setDsparkUrl}
                  onAutoInstall={canAutoInstallRunners ? () => handleAutoInstallRunner('dspark') : undefined}
                />
              </BackendSetupGroup>
            ) : selectedBackend === 'lemonade' ? (
              <BackendSetupGroup title={t('ONBOARDING_LEMONADE_SECTION_TITLE')} description={t('ONBOARDING_LEMONADE_SECTION_DESC')}>
                <LemonadeSetupCard status={lemonadeStatus} checking={checkingLemonade} onRecheck={handleLemonadeRecheck} />
              </BackendSetupGroup>
            ) : (
              <BackendSetupGroup title={t('ONBOARDING_OLLAMA_SECTION_TITLE')} description={t('ONBOARDING_OLLAMA_SECTION_DESC')}>
                <OllamaSetupCard status={ollamaStatus} checking={checkingOllama} onRecheck={handleOllamaRecheck} />
              </BackendSetupGroup>
            )}

            {isHostServedBackend(selectedBackend) && (
              <div className="space-y-3 border-t border-border pt-5" data-testid="embeddings-inference-setup">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{t('ONBOARDING_EMBEDDINGS_OLLAMA_SECTION_TITLE')}</h3>
                    <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                      {t('ONBOARDING_BADGE_RECOMMENDED')}
                    </span>
                  </div>
                  {selectedBackend !== 'dspark' && (
                    <p className="mt-1 text-xs text-muted-foreground">{t('ONBOARDING_EMBEDDINGS_OLLAMA_SECTION_DESC')}</p>
                  )}
                </div>
                {ollamaEmbeddingsWarning && (
                  <div
                    className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
                    data-testid="ollama-embeddings-warning"
                  >
                    {t('ONBOARDING_EMBEDDINGS_OLLAMA_WARNING')}
                  </div>
                )}
                <OllamaSetupCard status={ollamaStatus} checking={checkingOllama} onRecheck={handleOllamaRecheck} />
              </div>
            )}
          </StepSection>

          <ResourceSummaryBar
            selectedModels={selectedModels}
            installedCatalogIds={installedCatalogIds}
            availableStorageMb={availableDiskMb}
            availableMemoryMb={availableMemoryMb}
          />

          <RecommendedModels
            tier={profile.tier}
            recommendedModels={backendRecommendedModels}
            availableModels={backendAvailableModels}
            installedCatalogIds={installedCatalogIds}
            selectedModelIds={selectedModelIds}
            onToggleModel={handleToggleModel}
            preferredModelId={preferredModelId}
            chatBackend={selectedBackend}
          >
            <OtherModelsSection
              recommendedModels={backendRecommendedModels}
              availableModels={backendAvailableModels}
              installedCatalogIds={installedCatalogIds}
              selectedModelIds={selectedModelIds}
              onToggleModel={handleToggleModel}
              preferredModelId={preferredModelId}
            />
          </RecommendedModels>

          <CompanionAppsCard publicExposureMode={publicExposureMode} onChange={onCompanionAppsChange} />
        </>
      )}

      {embedded && children}

      <AdvancedDrawers providers={cloudProviders} onUpdateProviders={setCloudProviders} insufficientHardware={isInsufficient} />

      {!embedded && (
        <div className="flex items-center justify-between pt-1">
          <Button variant="ghost" onClick={onBack} data-testid="ai-back-btn">
            {t('COMMON_BACK')}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleSkip} data-testid="ai-skip-btn">
              {t('ONBOARDING_SKIP_TO_PRIVATE_VPN')}
            </Button>
            <Button
              intent="primary"
              onClick={handleContinue}
              data-testid="ai-continue-btn"
              disabled={
                !canAutoInstallRunners &&
                (needsOllamaForContinue || needsVllmForContinue || needsMtplxForContinue || needsDsparkForContinue || needsLemonadeForContinue) &&
                !isInsufficient &&
                ((needsOllamaForContinue && (checkingOllama || !ollamaStatus?.ready)) ||
                  (needsVllmForContinue && (checkingVllm || !vllmStatus?.ready)) ||
                  (needsMtplxForContinue && (checkingMtplx || !mtplxStatus?.ready)) ||
                  (needsDsparkForContinue && (checkingDspark || !dsparkStatus?.ready)) ||
                  (needsLemonadeForContinue && (checkingLemonade || !lemonadeStatus?.ready)))
              }
            >
              {isInsufficient && cloudProviders.filter((p) => p.apiKey.trim()).length === 0
                ? t('ONBOARDING_CONTINUE_PRIVATE_VPN_WITHOUT_AI')
                : t('ONBOARDING_CONTINUE_PRIVATE_VPN')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
