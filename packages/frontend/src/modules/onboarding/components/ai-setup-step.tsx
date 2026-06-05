import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import {
  validateCloudKey,
  type AgentFramework,
  type AiSetupConfig,
  type CloudProviderInput,
  type ExposureMode,
  type HardwareProfileResponse,
  type RemoteAccessMode,
} from '../helpers/ai-setup-types';
import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';
import { AgentFrameworkCard } from './ai-setup/agent-apps-card';
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

// Models a chat agent (Hermes, OpenClaw) can use as its default. LLMs are modality 'llm' in the real
// catalog; the purpose check keeps this robust across catalog shapes.
const AGENT_MODEL_PURPOSES = ['general', 'coding', 'reasoning', 'fast'];
const isAgentModel = (model: CuratedModel) => model.modality === 'llm' || AGENT_MODEL_PURPOSES.includes(model.purpose);

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
  /** Extra sections rendered between VPN (step 3) and Advanced (step 5) — used for step 4 on the one-page form. */
  children?: React.ReactNode;
}

interface OllamaStatus {
  ready: boolean;
  running: boolean;
  endpointUrl: string;
  bridgeUnreachable?: boolean;
  displayEndpoint?: string;
  hint?: string;
  error?: string;
}

// Seed the multi-select remote-access with whatever transports are already configured.
const defaultRemoteAccess = (cloudflareAvailable: boolean, tailscaleAvailable: boolean): RemoteAccessMode[] => {
  const modes: RemoteAccessMode[] = [];
  if (cloudflareAvailable) modes.push('cloudflare');
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
}: AiSetupStepProps) => {
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

  // Pre-select only models already present in Ollama. New downloads require an explicit checkbox.
  const getDefaultSelectedModelIds = (data: HardwareProfileResponse, backend: InferenceBackendType): string[] => {
    const installed = new Set(data.installedCatalogIds ?? []);
    return data.availableModels.filter((m) => m.backend === backend && installed.has(m.id)).map((m) => m.id);
  };

  const fetchProfile = async (isRescan = false) => {
    if (!isRescan) setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/inference/onboarding-profile', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: HardwareProfileResponse = await res.json();
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
      const res = await apiFetch('/api/inference/ollama/status', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: OllamaStatus = await res.json();
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
      const res = await apiFetch('/api/inference/hardware/rescan', { method: 'POST', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    return {
      agentFrameworks,
      selectedModels,
      backend: ONBOARDING_BACKEND,
      cloudProviders: validProviders,
      preferredModelId: effectivePreferredModelId,
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
    if (!config) throw new Error('AI profile unavailable');
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
          <Loader2 role="img" aria-label="loading" className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Detecting your hardware…</p>
        </div>
        <Skeleton className="h-24 w-full rounded-3xl" />
        <Skeleton className="h-48 w-full rounded-3xl" />
        <Skeleton className="h-32 w-full rounded-3xl" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="text-center py-8" data-testid="ai-setup-error">
        <p className="text-destructive mb-4">Failed to detect hardware: {error}</p>
        <div className="flex gap-2 justify-center">
          <Button variant="outline" onClick={() => fetchProfile()}>
            Retry
          </Button>
          <Button variant="ghost" onClick={handleSkip}>
            Skip AI Setup
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
  const liveConfig = buildConfig();

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
          <AgentFrameworkCard
            frameworks={agentFrameworks}
            onToggleFramework={toggleFramework}
            remoteAccess={remoteAccess}
            onToggleAccess={toggleAccess}
            cloudflareAvailable={cloudflareAvailable}
            tailscaleAvailable={tailscaleAvailable}
          />

          {/* Inference backend selection hidden — Ollama is the only option.
          <BackendCard /> */}

          {needsOllama && <OllamaSetupCard status={ollamaStatus} checking={checkingOllama} onRecheck={checkOllamaStatus} />}

          {/* Disk-available summary sits above the model selection so the budget is visible first. */}
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
            {/* Other Models lives at the bottom of the model-selection section (always visible). */}
            <OtherModelsSection
              recommendedModels={backendRecommendedModels}
              availableModels={backendAvailableModels}
              installedCatalogIds={installedCatalogIds}
              selectedModelIds={selectedModelIds}
              onToggleModel={handleToggleModel}
              preferredModelId={preferredModelId}
            />
          </RecommendedModels>
        </>
      )}

      {/* Step 3 — Private VPN. Rendered inline in the single-page form; the standalone wizard shows it as its own step. */}
      {embedded && <TailscaleSetupStep embedded />}

      {/* Step 4 slot — injected by the parent (e.g. Recommended Apps on the one-page FTUE form). */}
      {embedded && children}

      <AdvancedDrawers providers={cloudProviders} onUpdateProviders={setCloudProviders} insufficientHardware={isInsufficient} />

      {!embedded && (
        <div className="flex items-center justify-between pt-1">
          <Button variant="ghost" onClick={onBack} data-testid="ai-back-btn">
            Back
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleSkip} data-testid="ai-skip-btn">
              Skip to Private VPN
            </Button>
            <Button
              intent="primary"
              onClick={handleContinue}
              data-testid="ai-continue-btn"
              disabled={needsOllama && !isInsufficient && (checkingOllama || !ollamaStatus?.ready)}
            >
              {isInsufficient && cloudProviders.filter((p) => p.apiKey.trim()).length === 0
                ? 'Continue to Private VPN without AI'
                : 'Continue to Private VPN'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
