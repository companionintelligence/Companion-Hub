import { fetchInferenceOnboardingProfile, fetchOllamaInstallStatus, rescanInferenceHardware } from '@/lib/inference/inference-api';
import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import {
  validateCloudKey,
  type AgentFramework,
  type AiSetupConfig,
  type CloudProviderInput,
  type ExposureMode,
  type HardwareProfileResponse,
  type OllamaStatus,
  type RemoteAccessMode,
} from '../helpers/ai-setup-types';
import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';
import { AgentFrameworkCard } from './ai-setup/agent-apps-card';
import { AccessMethodsCard } from './ai-setup/access-methods-card';
import { CompanionAppsCard } from './ai-setup/companion-apps-card';
import { StepSection } from './ai-setup/primitives';
// Inference backend selection hidden — Ollama is the only option, so no choice is needed.
// import { BackendCard } from './ai-setup/backend-selection-card';
import { OtherModelsSection, RecommendedModels } from './ai-setup/model-selection-card';
import { AdvancedDrawers } from './ai-setup/advanced-drawers';
import { SystemOverview } from './ai-setup/system-overview';
import { ResourceSummaryBar } from './ai-setup/resource-summary-bar';
import { OllamaSetupCard } from './ai-setup/ollama-setup-card';
import { TailscaleSetupStep } from './tailscale-setup-step';
import { computeSelectionBudget } from '../helpers/onboarding-model-selection';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Models a chat agent (Hermes, OpenClaw) can use as its default.
// Only LLMs qualify here; embeddings / speech models may share a generic
// purpose label but must never become the default chat model.
const isAgentModel = (model: CuratedModel) => model.modality === 'llm';
const isEmbeddingModel = (model: CuratedModel) => model.modality === 'embedding';
const isVisionModel = (model: CuratedModel) => model.modality === 'llm' && model.metadata?.capabilities?.vision === true;

// Onboarding currently runs everything on Ollama; vLLM/Lemonade are shown but disabled.
const ONBOARDING_BACKEND: InferenceBackendType = 'ollama';

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
  const [checkingOllama, setCheckingOllama] = useState(false);

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

  // Pre-select only models already present in Ollama. New downloads require an explicit checkbox.
  const getDefaultSelectedModelIds = (data: HardwareProfileResponse, backend: InferenceBackendType): string[] => {
    const installed = new Set(data.installedCatalogIds ?? []);
    return data.availableModels.filter((m) => m.backend === backend && installed.has(m.id)).map((m) => m.id);
  };

  const fetchProfile = async (isRescan = false) => {
    if (!isRescan) setLoading(true);
    setError(null);
    try {
      const data = await fetchInferenceOnboardingProfile();
      setProfile(data);
      const defaultSelected = getDefaultSelectedModelIds(data, ONBOARDING_BACKEND);
      setSelectedModelIds(defaultSelected);
      setPreferredModelId(getDefaultPreferredModelId(data, ONBOARDING_BACKEND, defaultSelected));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (!isRescan) setLoading(false);
      setRescanning(false);
    }
  };

  // Ollama runs on the host (reached via host.docker.internal); this only checks reachability.
  const checkOllamaStatus = async () => {
    setCheckingOllama(true);
    try {
      const data = (await fetchOllamaInstallStatus()) as OllamaStatus;
      setOllamaStatus(data);
    } catch (_e) {
      // Silently fail - Ollama status is optional
      setOllamaStatus({ ready: false, running: false, endpointUrl: '' });
    } finally {
      setCheckingOllama(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount
  useEffect(() => {
    fetchProfile();
    checkOllamaStatus();
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

  const handleToggleModel = (modelId: string) => {
    const isRemoving = selectedModelIds.includes(modelId);
    const next = isRemoving ? selectedModelIds.filter((id) => id !== modelId) : [...selectedModelIds, modelId];
    setSelectedModelIds(next);
    const isAgent = profile?.availableModels.some((m) => m.id === modelId && m.backend === ONBOARDING_BACKEND && isAgentModel(m)) ?? false;
    if (isRemoving && modelId === preferredModelId) {
      // The agent's preferred model was removed — fall back to another selected agent model.
      const fallback = profile?.availableModels.find((m) => m.backend === ONBOARDING_BACKEND && isAgentModel(m) && next.includes(m.id))?.id;
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
      .filter((model) => model.backend === ONBOARDING_BACKEND && selectedModelIds.includes(model.id))
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
    const effectivePreferredEmbeddingModelId = getDefaultPreferredAuxModelId(profile, ONBOARDING_BACKEND, isEmbeddingModel, selectedModels);
    const effectivePreferredVisionModelId = getDefaultPreferredAuxModelId(profile, ONBOARDING_BACKEND, isVisionModel, selectedModels);

    return {
      agentFrameworks,
      selectedModels,
      backend: ONBOARDING_BACKEND,
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
  }, [embedded, profile, agentFrameworks, selectedModelIds, preferredModelId, remoteAccess, cloudProviders, onConfigChange]);

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
    // report the probe diagnosis instead whenever we have one.
    return (
      <div className="py-8" data-testid="ai-setup-error">
        <p className="text-destructive mb-4 text-center">
          {t('ONBOARDING_AI_SETUP_FAILED')}: {error}
        </p>
        {ollamaStatus?.hint && (
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
  const backendRecommendedModels = profile.recommendedModels.filter((model) => model.backend === ONBOARDING_BACKEND);
  const backendAvailableModels = profile.availableModels.filter((model) => model.backend === ONBOARDING_BACKEND);
  const selectedModels = backendAvailableModels.filter((model) => selectedModelIds.includes(model.id));
  const installedCatalogIds = profile.installedCatalogIds ?? [];
  const availableDiskMb = profile.resourceEstimate.availableDiskMb;
  const diskTotalMb = profile.resourceEstimate.diskTotalMb;
  const availableMemoryMb = profile.resourceEstimate.availableMemoryMb;
  const needsOllama = ollamaStatus === null || !ollamaStatus.ready;
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

          <StepSection number={3} badge="required" title={t('ONBOARDING_OLLAMA_SECTION_TITLE')} description={t('ONBOARDING_OLLAMA_SECTION_DESC')}>
            <OllamaSetupCard status={ollamaStatus} checking={checkingOllama} onRecheck={checkOllamaStatus} />
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
              disabled={needsOllama && !isInsufficient && (checkingOllama || !ollamaStatus?.ready)}
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
