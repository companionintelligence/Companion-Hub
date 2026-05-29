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
} from '../helpers/ai-setup-types';
import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';
import { AgentFrameworkCard } from './ai-setup/agent-apps-card';
import { BackendCard } from './ai-setup/backend-selection-card';
import { RecommendedModels } from './ai-setup/model-selection-card';
import { AdvancedDrawers } from './ai-setup/advanced-drawers';
import { SystemOverview } from './ai-setup/system-overview';
import { ResourceSummaryBar } from './ai-setup/resource-summary-bar';
import { OllamaSetupCard } from './ai-setup/ollama-setup-card';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { Loader2 } from 'lucide-react';

// Models a chat agent (Hermes, OpenClaw) can use as its default. LLMs are modality 'llm' in the real
// catalog; the purpose check keeps this robust across catalog shapes.
const AGENT_MODEL_PURPOSES = ['general', 'coding', 'reasoning', 'fast'];
const isAgentModel = (model: CuratedModel) => model.modality === 'llm' || AGENT_MODEL_PURPOSES.includes(model.purpose);

// Onboarding currently runs everything on Ollama; vLLM/Lemonade are shown but disabled.
const ONBOARDING_BACKEND: InferenceBackendType = 'ollama';

interface AiSetupStepProps {
  onComplete: (config: AiSetupConfig) => void;
  onSkip: () => void;
  onBack: () => void;
  /** Whether a Cloudflare tunnel is configured — seeds the default agent remote-access choice. */
  cloudflareAvailable?: boolean;
  /** Whether Tailscale is connected — seeds the default agent remote-access choice. */
  tailscaleAvailable?: boolean;
}

interface OllamaStatus {
  ready: boolean;
  running: boolean;
  endpointUrl: string;
  error?: string;
}

const defaultExposureMode = (cloudflareAvailable: boolean, tailscaleAvailable: boolean): ExposureMode =>
  cloudflareAvailable ? 'cloudflare' : tailscaleAvailable ? 'tailscale' : 'local';

export const AiSetupStep = ({ onComplete, onSkip, onBack, cloudflareAvailable = false, tailscaleAvailable = false }: AiSetupStepProps) => {
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ollamaInstallError, setOllamaInstallError] = useState<string | null>(null);
  const [profile, setProfile] = useState<HardwareProfileResponse | null>(null);
  const [agentFramework, setAgentFramework] = useState<AgentFramework>('openclaw');
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [preferredModelId, setPreferredModelId] = useState<string | undefined>(undefined);
  const [exposureMode, setExposureMode] = useState<ExposureMode>(defaultExposureMode(cloudflareAvailable, tailscaleAvailable));
  const [cloudProviders, setCloudProviders] = useState<CloudProviderInput[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [checkingOllama, setCheckingOllama] = useState(false);
  const [installingOllama, setInstallingOllama] = useState(false);

  const getRecommendedModelIdsForBackend = (data: HardwareProfileResponse, backend: InferenceBackendType) =>
    data.recommendedModels.filter((model) => model.backend === backend).map((model) => model.id);

  // The default model Companion agents (Hermes, OpenClaw) use: the top recommended agent model that is
  // actually installable for the backend, falling back to the first installable agent model.
  const getDefaultPreferredModelId = (data: HardwareProfileResponse, backend: InferenceBackendType): string | undefined => {
    const recommendedAgentIds = new Set(data.recommendedModels.filter((m) => m.backend === backend && isAgentModel(m)).map((m) => m.id));
    const installable = data.availableModels.filter((m) => m.backend === backend && isAgentModel(m));
    return installable.find((m) => recommendedAgentIds.has(m.id))?.id ?? installable[0]?.id;
  };

  const fetchProfile = async (isRescan = false) => {
    if (!isRescan) setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/inference/onboarding-profile', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: HardwareProfileResponse = await res.json();
      setProfile(data);
      setSelectedModelIds(getRecommendedModelIdsForBackend(data, ONBOARDING_BACKEND));
      setPreferredModelId(getDefaultPreferredModelId(data, ONBOARDING_BACKEND));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (!isRescan) setLoading(false);
      setRescanning(false);
    }
  };

  const checkOllamaStatus = async () => {
    setCheckingOllama(true);
    setOllamaInstallError(null);
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

  const handleInstallOllama = async () => {
    setOllamaInstallError(null);
    setInstallingOllama(true);
    try {
      const res = await apiFetch('/api/inference/ollama/install', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { success: boolean; message: string } = await res.json();

      if (data.success) {
        await checkOllamaStatus();
      } else {
        setOllamaInstallError(data.message);
      }
    } catch (e) {
      setOllamaInstallError((e as Error).message);
    } finally {
      setInstallingOllama(false);
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

  // Picking a preferred model also ensures it is installed (added to the selected set).
  const handleSelectPreferred = (modelId: string) => {
    setPreferredModelId(modelId);
    setSelectedModelIds((prev) => (prev.includes(modelId) ? prev : [...prev, modelId]));
  };

  const handleContinue = () => {
    if (!profile) {
      throw new Error('AI profile unavailable');
    }
    const backendCompatibleSelectedModels = profile.availableModels
      .filter((model) => model.backend === ONBOARDING_BACKEND && selectedModelIds.includes(model.id))
      .map((model) => model.id);
    const validProviders = cloudProviders.filter((p) => {
      if (!p.apiKey.trim()) return false;
      return !validateCloudKey(p.provider, p.apiKey);
    });
    // Persist the preferred model only when it is actually being installed; otherwise default to the
    // first selected agent model so the agent always has a runnable default.
    const effectivePreferredModelId =
      preferredModelId && backendCompatibleSelectedModels.includes(preferredModelId)
        ? preferredModelId
        : backendCompatibleSelectedModels.find((id) => profile.availableModels.some((m) => m.id === id && isAgentModel(m)));
    onComplete({
      agentFramework,
      selectedModels: backendCompatibleSelectedModels,
      backend: ONBOARDING_BACKEND,
      cloudProviders: validProviders,
      preferredModelId: effectivePreferredModelId,
      exposureMode,
      skipped: false,
    });
  };

  const handleSkip = () => {
    onSkip();
  };

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
  const recommendedAgentModelIds = new Set(backendRecommendedModels.filter(isAgentModel).map((m) => m.id));
  const agentModels = backendAvailableModels
    .filter(isAgentModel)
    .sort((a, b) => Number(recommendedAgentModelIds.has(b.id)) - Number(recommendedAgentModelIds.has(a.id)));
  const availableMemoryMb = profile.resourceEstimate.availableMemoryMb;
  const needsOllama = ollamaStatus === null || !ollamaStatus.ready;

  return (
    <div className="space-y-5 max-h-[66vh] overflow-y-auto pr-2" data-testid="ai-setup-step">
      {!isInsufficient && (
        <>
          <AgentFrameworkCard
            framework={agentFramework}
            onSelectFramework={setAgentFramework}
            models={agentModels}
            preferredModelId={preferredModelId}
            onSelectPreferred={handleSelectPreferred}
            exposureMode={exposureMode}
            onSelectExposureMode={setExposureMode}
            cloudflareAvailable={cloudflareAvailable}
            tailscaleAvailable={tailscaleAvailable}
          />

          <BackendCard />

          {needsOllama && (
            <OllamaSetupCard
              status={ollamaStatus}
              installing={installingOllama}
              checking={checkingOllama}
              onInstall={handleInstallOllama}
              onRecheck={checkOllamaStatus}
              errorMessage={ollamaInstallError}
            />
          )}

          <RecommendedModels
            tier={profile.tier}
            recommendedModels={backendRecommendedModels}
            availableModels={backendAvailableModels}
            selectedModelIds={selectedModelIds}
            onToggleModel={handleToggleModel}
            preferredModelId={preferredModelId}
          />

          <ResourceSummaryBar selectedModels={selectedModels} availableMemoryMb={availableMemoryMb} />
        </>
      )}

      <SystemOverview hardware={profile.hardware} tier={profile.tier} onRescan={handleRescan} rescanning={rescanning} />

      <AdvancedDrawers
        recommendedModels={backendRecommendedModels}
        availableModels={backendAvailableModels}
        selectedModelIds={selectedModelIds}
        onToggleModel={handleToggleModel}
        preferredModelId={preferredModelId}
        providers={cloudProviders}
        onUpdateProviders={setCloudProviders}
        insufficientHardware={isInsufficient}
      />

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
            disabled={needsOllama && !isInsufficient && (installingOllama || checkingOllama || !ollamaStatus?.ready)}
          >
            {isInsufficient && cloudProviders.filter((p) => p.apiKey.trim()).length === 0
              ? 'Continue to Private VPN without AI'
              : 'Continue to Private VPN'}
          </Button>
        </div>
      </div>
    </div>
  );
};
