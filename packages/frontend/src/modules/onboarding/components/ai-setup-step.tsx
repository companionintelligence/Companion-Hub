import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import { validateCloudKey, type AiSetupConfig, type CloudProviderInput, type HardwareProfileResponse } from '../helpers/ai-setup-types';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { HardwareProfileCard } from './ai-setup/hardware-profile-card';
import { ModelSelectionCard } from './ai-setup/model-selection-card';
import { BackendSelectionCard } from './ai-setup/backend-selection-card';
import { CloudProviderCard } from './ai-setup/cloud-provider-card';
import { ResourceSummaryBar } from './ai-setup/resource-summary-bar';
import { OllamaSetupCard } from './ai-setup/ollama-setup-card';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { Loader2 } from 'lucide-react';

interface AiSetupStepProps {
  onComplete: (config: AiSetupConfig) => void;
  onSkip: () => void;
  onBack: () => void;
}

interface OllamaStatus {
  installed: boolean;
  version?: string;
  installPath?: string;
  needsInstall: boolean;
  running: boolean;
  ready: boolean;
  endpointUrl: string;
  error?: string;
}

export const AiSetupStep = ({ onComplete, onSkip, onBack }: AiSetupStepProps) => {
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ollamaInstallError, setOllamaInstallError] = useState<string | null>(null);
  const [profile, setProfile] = useState<HardwareProfileResponse | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<InferenceBackendType>('ollama');
  const [cloudProviders, setCloudProviders] = useState<CloudProviderInput[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [checkingOllama, setCheckingOllama] = useState(false);
  const [installingOllama, setInstallingOllama] = useState(false);

  const getRecommendedModelIdsForBackend = (data: HardwareProfileResponse, backend: InferenceBackendType) =>
    data.recommendedModels.filter((model) => model.backend === backend).map((model) => model.id);

  const fetchProfile = async (isRescan = false) => {
    if (!isRescan) setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/inference/onboarding-profile', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: HardwareProfileResponse = await res.json();
      setProfile(data);
      setSelectedBackend(data.backends.recommended);
      setSelectedModelIds(getRecommendedModelIdsForBackend(data, data.backends.recommended));
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
      setOllamaStatus({ installed: false, needsInstall: true, running: false, ready: false, endpointUrl: '' });
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
        // Re-check status after installation
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
    setSelectedModelIds((prev) => (prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId]));
  };

  const handleContinue = () => {
    if (!profile) {
      throw new Error('AI profile unavailable');
    }
    const backendCompatibleSelectedModels = profile.availableModels
      .filter((model) => model.backend === selectedBackend && selectedModelIds.includes(model.id))
      .map((model) => model.id);
    const validProviders = cloudProviders.filter((p) => {
      if (!p.apiKey.trim()) return false;
      return !validateCloudKey(p.provider, p.apiKey);
    });
    onComplete({
      selectedModels: backendCompatibleSelectedModels,
      backend: selectedBackend,
      cloudProviders: validProviders,
      skipped: false,
    });
  };

  const handleSkip = () => {
    onSkip();
  };

  if (loading) {
    return (
      <div className="space-y-4 max-h-[62vh] overflow-y-auto pr-2" data-testid="ai-setup-loading">
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <Loader2 role="img" aria-label="loading" className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Detecting your hardware…</p>
        </div>
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
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
  const backendRecommendedModels = profile.recommendedModels.filter((model) => model.backend === selectedBackend);
  const backendAvailableModels = profile.availableModels.filter((model) => model.backend === selectedBackend);
  const selectedModels = backendAvailableModels.filter((model) => selectedModelIds.includes(model.id));
  const availableMemoryMb = profile.resourceEstimate.availableMemoryMb;
  const needsOllama = selectedBackend === 'ollama' && (ollamaStatus === null || !ollamaStatus.ready);

  return (
    <div className="space-y-4 max-h-[62vh] overflow-y-auto pr-2" data-testid="ai-setup-step">
      <HardwareProfileCard hardware={profile.hardware} tier={profile.tier} onRescan={handleRescan} rescanning={rescanning} />

      {!isInsufficient && (
        <>
          {/* Show Ollama setup card if needed */}
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

          <ModelSelectionCard
            tier={profile.tier}
            recommendedModels={backendRecommendedModels}
            availableModels={backendAvailableModels}
            selectedModelIds={selectedModelIds}
            onToggleModel={handleToggleModel}
          />

          <BackendSelectionCard
            recommended={profile.backends.recommended}
            available={profile.backends.available}
            selected={selectedBackend}
            onSelect={(backend) => {
              setSelectedBackend(backend);
              setSelectedModelIds(getRecommendedModelIdsForBackend(profile, backend));
            }}
          />

          <ResourceSummaryBar selectedModels={selectedModels} availableMemoryMb={availableMemoryMb} />
        </>
      )}

      <CloudProviderCard providers={cloudProviders} insufficientHardware={isInsufficient} onUpdate={setCloudProviders} />

      <div className="flex items-center justify-between pt-2">
        <Button variant="ghost" onClick={onBack} data-testid="ai-back-btn">
          Back
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleSkip} data-testid="ai-skip-btn">
            Skip AI Setup
          </Button>
          <Button
            intent="primary"
            onClick={handleContinue}
            data-testid="ai-continue-btn"
            disabled={needsOllama && (installingOllama || checkingOllama || !ollamaStatus?.ready)}
          >
            {isInsufficient && cloudProviders.filter((p) => p.apiKey.trim()).length === 0 ? 'Continue without AI' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  );
};
