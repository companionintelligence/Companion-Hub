import {
  fetchInferenceOnboardingProfile,
  fetchOllamaInstallStatus,
  fetchDsparkInstallStatus,
  fetchVllmInstallStatus,
  rescanInferenceHardware,
} from '@/lib/inference/inference-api';
import { openExternal } from '@/lib/helpers/open-external';
import { Button } from '@/components/ui/Button';
import { useEffect, useRef, useState } from 'react';
import {
  validateCloudKey,
  type AgentFramework,
  type AiSetupConfig,
  type CloudProviderInput,
  type ExposureMode,
  type HardwareProfileResponse,
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
import { DsparkSetupCard } from './ai-setup/dspark-setup-card';
import { TailscaleSetupStep } from './tailscale-setup-step';
import { computeSelectionBudget } from '../helpers/onboarding-model-selection';
import { EMBEDDING_INFERENCE_BACKEND, isHostServedBackend, unavailableInferenceBackends } from '../helpers/inference-backend-availability';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Models a chat agent (Hermes, OpenClaw) can use as its default.
// Only LLMs qualify here; embeddings / speech models may share a generic
// purpose label but must never become the default chat model.
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
   * Section mode for the single-page FTUE form: hides the step navigation, drops the internal
   * scroll, and emits the live config via {@link onConfigChange} instead of waiting for a Continue.
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
  const [dsparkStatus, setDsparkStatus] = useState<DsparkStatus | null>(null);
  const [checkingOllama, setCheckingOllama] = useState(false);
  const [checkingVllm, setCheckingVllm] = useState(false);
  const [checkingDspark, setCheckingDspark] = useState(false);
  const [vllmApiKey, setVllmApiKey] = useState('');
  const [vllmUrl, setVllmUrl] = useState('');
  const [dsparkUrl, setDsparkUrl] = useState('');
  const [selectedBackend, setSelectedBackend] = useState<InferenceBackendType>('ollama');

  // Three code paths fetch the same profile endpoint concurrently (mount/Rescan, backend switch,
  // and the Re-check refresh below). Each stamps its request, so a slow answer can be recognised as
  // superseded and dropped instead of reverting the state the operator is actually looking at.
  const profileRequestId = useRef(0);
  // Mirrors of the selection state, read by the refresh *after* its await: the render closure still
  // holds the values from the moment of the click, so writing back from it would silently revert
  // anything the operator changed while the fetch was in flight.
  const selectedModelIdsRef = useRef(selectedModelIds);
  selectedModelIdsRef.current = selectedModelIds;
  const preferredModelIdRef = useRef(preferredModelId);
  preferredModelIdRef.current = preferredModelId;

  // The default model Companion agents (Hermes, OpenClaw) use: the BEST-FIT agent LLM. recommendedModels
  // is ordered best-first (index 0 is the largest model that fits the hardware budget), so we walk it
  // in order and take the top installable agent LLM — not whatever happens to come first in the catalog.
  // Both agents read this single model from the Hub's bootstrap.env, so it must be the best-fit pick.
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
      const data = await fetchInferenceOnboardingProfile(backend, vllmUrl, backend === 'vllm' ? vllmApiKey : undefined, dsparkUrl);
      // Superseded: a rescan that started before a backend switch but answers after it would push
      // `backends.recommended` back over the backend the operator just picked, and reset their
      // selection to that backend's defaults.
      if (profileRequestId.current !== requestId) return;
      setProfile(data);
      const resolvedBackend = backendOverride ?? data.backends.recommended;
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
      // Deliberately unguarded: `handleSelectBackend` bumps the request id without owning these
      // flags, so skipping the clear when superseded would strand the spinner with nothing left to
      // stop it. Clearing a beat early is cosmetic; a spinner that never stops is not.
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

  // "Re-check" is the documented last step of both backend flows ("start it, then re-check" /
  // "load a model in your host vLLM server, then Re-check"), so it must also refresh what the
  // backend reports as installed: `installedCatalogIds` is what decides whether a model card reads
  // as installed and selectable, and a status probe alone leaves it at the value fetched on mount.
  //
  // Deliberately narrower than `fetchProfile`, which exists to (re)establish defaults. Re-checking
  // must not discard model choices already made, must not reset a hand-picked backend, and must not
  // replace the whole step with the error screen when the refresh fails — the status probe is the
  // signal the operator asked for, and their in-progress setup outweighs a stale model list.
  const refreshInstalledModels = async (backend: InferenceBackendType) => {
    const requestId = ++profileRequestId.current;
    try {
      const previouslyInstalled = new Set(profile?.installedCatalogIds ?? []);
      const data = await fetchInferenceOnboardingProfile(backend, vllmUrl, backend === 'vllm' ? vllmApiKey : undefined, dsparkUrl);
      // Drop a superseded answer. Rescan and the backend selector write the same `profile`, so a
      // refresh that started first but landed last would reinstate pre-rescan hardware figures, or
      // leave `profile` scoped to a backend the operator has already switched away from.
      if (profileRequestId.current !== requestId) return;
      setProfile(data);

      const nextInstalled = new Set(data.installedCatalogIds ?? []);
      // Adopt only models that appeared since the last look, so an earlier opt-out survives.
      const newlySelectable = getDefaultSelectedModelIds(data, backend).filter((id) => !previouslyInstalled.has(id));
      // The Hub cannot pull a vLLM model, so `handleToggleModel` only lets one be ticked while the
      // host is serving it. Drop the ones it stopped serving to keep that invariant: left ticked,
      // `computeSelectionBudget` bills them as pending downloads and can block Continue on disk.
      const isStillSelectable = (id: string) => data.availableModels.find((m) => m.id === id)?.backend !== 'vllm' || nextInstalled.has(id);
      const nextSelected = [...new Set([...selectedModelIdsRef.current, ...newlySelectable])].filter(isStillSelectable);
      setSelectedModelIds(nextSelected);

      // `fetchProfile` seeds the agent default from the catalog before anything is installed, so
      // that placeholder must give way once the backend reports what it is really serving —
      // otherwise the "agent default" badge sits on a model the host does not have. A model the
      // operator picked (installed, or ticked for download) is never overridden.
      const preferred = preferredModelIdRef.current;
      setPreferredModelId(
        preferred && (nextInstalled.has(preferred) || nextSelected.includes(preferred))
          ? preferred
          : getDefaultPreferredModelId(data, backend, nextSelected),
      );
    } catch (e) {
      // Best-effort refresh: the status probe already reported reachability, and taking the whole
      // step down over a secondary fetch would discard an in-progress setup. Leave a trace though —
      // a silent no-op here is indistinguishable from the bug this function exists to fix.
      console.warn('Re-check could not refresh the installed model list', e);
    }
  };

  // Kept separate from the probe helpers because those also run on mount, where `selectedBackend`
  // is still the initial value and a refresh would read the wrong backend.
  const handleRecheck = async (probe: () => Promise<{ ready: boolean }>, setChecking: (checking: boolean) => void) => {
    const status = await probe();
    // The profile endpoint swallows its own backend health-check failure and answers 200 with
    // nothing served, so refreshing against a backend that is down does not reveal a new model —
    // it erases the ones already there, dropping every card back into the "open Hugging Face"
    // branch this fix exists to leave. The probe is the gate.
    if (!status.ready) return;
    // The probe clears its own `checking` flag the moment it returns, and `Button` is only disabled
    // while `loading`. Hold the control busy for the slower half too, so the operator is not invited
    // to click again — a second refresh racing the first is how the stale answer wins.
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount
  useEffect(() => {
    void (async () => {
      await fetchProfile(false);
      await Promise.all([checkOllamaStatus(), checkVllmStatus(), checkDsparkStatus()]);
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
      const data = await fetchInferenceOnboardingProfile(backend, vllmUrl, backend === 'vllm' ? vllmApiKey : undefined, dsparkUrl);
      // `setSelectedBackend` above is synchronous, so two quick switches already end on the right
      // backend — but the slower fetch can still answer last and leave `profile` (and the selection
      // derived from it) describing the backend the operator switched away from.
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
    }
    if (backend === 'dspark') {
      void checkDsparkStatus();
    }
  };

  const handleToggleModel = (modelId: string) => {
    const model = profile?.availableModels.find((m) => m.id === modelId);
    const installed = new Set(profile?.installedCatalogIds ?? []);
    // vLLM only: the Hub cannot load a model into a host vLLM server, so selecting an uninstalled
    // one sends the operator to Hugging Face to fetch it themselves. mlx-dspark is deliberately NOT
    // included — the Hub loads its models over `POST /admin/load`, so they tick like Ollama's.
    if (model?.backend === 'vllm' && !installed.has(modelId) && !selectedModelIds.includes(modelId)) {
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
    const effectivePreferredEmbeddingModelId = getDefaultPreferredAuxModelId(profile, EMBEDDING_INFERENCE_BACKEND, isEmbeddingModel, selectedModels);
    const effectivePreferredVisionModelId = getDefaultPreferredAuxModelId(profile, selectedBackend, isVisionModel, selectedModels);

    return {
      agentFrameworks,
      selectedModels,
      ollamaSelectedModelIds: profile.availableModels.filter((m) => selectedModels.includes(m.id) && m.backend === 'ollama').map((m) => m.id),
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
    // The profile endpoint bundles hardware detection with live probes of the
    // inference backends, so a blocked host service fails the whole call. Naming
    // hardware here sent operators after the one component that was working —
    // report the probe diagnosis instead, but only when the probe actually found
    // a bridge failure, so an unrelated profile error is not blamed on Ollama.
    return (
      <div className="py-8" data-testid="ai-setup-error">
        <p className="text-destructive mb-4 text-center">
          {t('ONBOARDING_AI_SETUP_FAILED')}: {error}
        </p>
        {ollamaStatus?.bridgeUnreachable && ollamaStatus.hint && (
          <div className="mx-auto mb-4 max-w-2xl rounded-lg border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950 p-3">
            <div className="text-xs text-yellow-800 dark:text-yellow-200">{ollamaStatus.hint}</div>
            {ollamaStatus.remediationCommand && (
              <>
                <div className="mt-2 mb-1 text-xs font-medium text-yellow-900 dark:text-yellow-100">{t('ONBOARDING_OLLAMA_RUN_ON_HOST')}</div>
                <code className="block overflow-x-auto whitespace-pre rounded bg-yellow-100 dark:bg-yellow-900 px-2 py-1.5 text-xs text-yellow-900 dark:text-yellow-100">
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
  const needsDsparkForContinue = selectedBackend === 'dspark' && (dsparkStatus === null || !dsparkStatus.ready);
  // Both host-run backends leave embeddings on Ollama, so the co-install warning covers both.
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

          <BackendSelectionCard
            recommended={profile.backends.recommended}
            available={profile.backends.available}
            selected={selectedBackend}
            onSelect={handleSelectBackend}
            unavailableTypes={unavailableInferenceBackends(profile)}
          />

          {selectedBackend === 'vllm' ? (
            <StepSection number={3} badge="required" title={t('ONBOARDING_VLLM_SECTION_TITLE')} description={t('ONBOARDING_VLLM_SECTION_DESC')}>
              <VllmSetupCard
                status={vllmStatus}
                checking={checkingVllm}
                onRecheck={handleVllmRecheck}
                apiKey={vllmApiKey}
                onApiKeyChange={setVllmApiKey}
                endpointUrl={vllmUrl}
                onEndpointUrlChange={setVllmUrl}
              />
            </StepSection>
          ) : selectedBackend === 'dspark' ? (
            <StepSection number={3} badge="required" title={t('ONBOARDING_DSPARK_SECTION_TITLE')} description={t('ONBOARDING_DSPARK_SECTION_DESC')}>
              <DsparkSetupCard
                status={dsparkStatus}
                checking={checkingDspark}
                onRecheck={handleDsparkRecheck}
                endpointUrl={dsparkUrl}
                onEndpointUrlChange={setDsparkUrl}
              />
            </StepSection>
          ) : (
            <StepSection number={3} badge="required" title={t('ONBOARDING_OLLAMA_SECTION_TITLE')} description={t('ONBOARDING_OLLAMA_SECTION_DESC')}>
              <OllamaSetupCard status={ollamaStatus} checking={checkingOllama} onRecheck={handleOllamaRecheck} />
            </StepSection>
          )}

          {isHostServedBackend(selectedBackend) && (
            <StepSection
              number={3}
              badge="recommended"
              title={t('ONBOARDING_EMBEDDINGS_OLLAMA_SECTION_TITLE')}
              description={t(
                selectedBackend === 'dspark' ? 'ONBOARDING_EMBEDDINGS_DSPARK_SECTION_DESC' : 'ONBOARDING_EMBEDDINGS_OLLAMA_SECTION_DESC',
              )}
            >
              {ollamaEmbeddingsWarning && (
                <div
                  className="mb-3 rounded-md border border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950 px-3 py-2 text-xs text-yellow-800 dark:text-yellow-200"
                  data-testid="ollama-embeddings-warning"
                >
                  {t('ONBOARDING_EMBEDDINGS_OLLAMA_WARNING')}
                </div>
              )}
              <OllamaSetupCard status={ollamaStatus} checking={checkingOllama} onRecheck={handleOllamaRecheck} />
            </StepSection>
          )}

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
                (needsOllamaForContinue || needsVllmForContinue || needsDsparkForContinue) &&
                !isInsufficient &&
                ((needsOllamaForContinue && (checkingOllama || !ollamaStatus?.ready)) ||
                  (needsVllmForContinue && (checkingVllm || !vllmStatus?.ready)) ||
                  (needsDsparkForContinue && (checkingDspark || !dsparkStatus?.ready)))
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
