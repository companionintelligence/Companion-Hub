import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { useEffect, useState } from 'react';
import type { AiSetupConfig, CloudProviderInput, HardwareProfileResponse } from '../helpers/ai-setup-types';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { HardwareProfileCard } from './ai-setup/hardware-profile-card';
import { ModelSelectionCard } from './ai-setup/model-selection-card';
import { BackendSelectionCard } from './ai-setup/backend-selection-card';
import { CloudProviderCard } from './ai-setup/cloud-provider-card';
import { ResourceSummaryBar } from './ai-setup/resource-summary-bar';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';

interface AiSetupStepProps {
  onComplete: (config: AiSetupConfig) => void;
  onSkip: () => void;
  onBack: () => void;
}

export const AiSetupStep = ({ onComplete, onSkip, onBack }: AiSetupStepProps) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<HardwareProfileResponse | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<InferenceBackendType>('ollama');
  const [cloudProviders, setCloudProviders] = useState<CloudProviderInput[]>([]);

  const fetchProfile = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/inference/onboarding-profile', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: HardwareProfileResponse = await res.json();
      setProfile(data);
      setSelectedModelIds(data.recommendedModels.map((m) => m.id));
      setSelectedBackend(data.backends.recommended);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount
  useEffect(() => {
    fetchProfile();
  }, []);

  const handleRescan = async () => {
    await apiFetch('/api/inference/hardware/rescan', { method: 'POST', credentials: 'include' });
    await fetchProfile();
  };

  const handleToggleModel = (modelId: string) => {
    setSelectedModelIds((prev) => (prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId]));
  };

  const handleContinue = () => {
    onComplete({
      selectedModels: selectedModelIds,
      backend: selectedBackend,
      cloudProviders: cloudProviders.filter((p) => p.apiKey.trim()),
      skipped: false,
    });
  };

  const handleSkip = () => {
    onSkip();
  };

  if (loading) {
    return (
      <div className="space-y-4" data-testid="ai-setup-loading">
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
          <Button variant="outline" onClick={fetchProfile}>
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
  const selectedModels = profile.availableModels.filter((m) => selectedModelIds.includes(m.id));
  const availableMemoryMb = profile.resourceEstimate.availableMemoryMb;

  return (
    <div className="space-y-4" data-testid="ai-setup-step">
      <HardwareProfileCard hardware={profile.hardware} tier={profile.tier} onRescan={handleRescan} />

      {!isInsufficient && (
        <>
          <ModelSelectionCard
            tier={profile.tier}
            recommendedModels={profile.recommendedModels}
            availableModels={profile.availableModels}
            selectedModelIds={selectedModelIds}
            onToggleModel={handleToggleModel}
          />

          <BackendSelectionCard
            recommended={profile.backends.recommended}
            available={profile.backends.available}
            selected={selectedBackend}
            onSelect={setSelectedBackend}
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
          <Button intent="primary" onClick={handleContinue} data-testid="ai-continue-btn">
            {isInsufficient && cloudProviders.filter((p) => p.apiKey.trim()).length === 0 ? 'Continue without AI' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>
  );
};
