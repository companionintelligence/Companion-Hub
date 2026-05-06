import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton/Skeleton';
import { Brain, RefreshCw, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import type { CloudProviderInput, HardwareProfileResponse } from '@/modules/onboarding/helpers/ai-setup-types';
import type { CloudProviderType, InferenceBackendType } from '@ci-hub/common/types';
import { HardwareProfileCard } from '@/modules/onboarding/components/ai-setup/hardware-profile-card';
import { ModelSelectionCard } from '@/modules/onboarding/components/ai-setup/model-selection-card';
import { BackendSelectionCard } from '@/modules/onboarding/components/ai-setup/backend-selection-card';
import { CloudProviderCard } from '@/modules/onboarding/components/ai-setup/cloud-provider-card';
import { ResourceSummaryBar } from '@/modules/onboarding/components/ai-setup/resource-summary-bar';

export const AiSettingsContainer = () => {
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<HardwareProfileResponse | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<InferenceBackendType>('ollama');
  const [cloudProviders, setCloudProviders] = useState<CloudProviderInput[]>([]);
  const [pinnedModelIds, setPinnedModelIds] = useState<Set<string>>(new Set());

  const fetchProfile = async (isRescan = false) => {
    if (!isRescan) setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/inference/onboarding-profile', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: HardwareProfileResponse = await res.json();
      setProfile(data);

      // Load currently tracked/pinned models
      const trackedRes = await apiFetch('/api/inference/models/tracked', { credentials: 'include' });
      if (trackedRes.ok) {
        const tracked = await trackedRes.json();
        const pinned = new Set<string>();
        const selectedIds: string[] = [];
        for (const model of tracked) {
          if (model.state === 'pinned' || model.state === 'loaded' || model.state === 'pulled') {
            selectedIds.push(model.catalogId);
          }
          if (model.state === 'pinned') {
            pinned.add(model.catalogId);
          }
        }
        setPinnedModelIds(pinned);
        // If we have tracked models, use those; otherwise use recommended
        if (selectedIds.length > 0) {
          setSelectedModelIds(selectedIds);
        } else {
          setSelectedModelIds(data.recommendedModels.map((m) => m.id));
        }
      } else {
        setSelectedModelIds(data.recommendedModels.map((m) => m.id));
      }

      setSelectedBackend(data.backends.recommended);

      // Load configured cloud providers
      const cloudRes = await apiFetch('/api/inference/cloud-providers', { credentials: 'include' });
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

  const handleRescan = async () => {
    setRescanning(true);
    try {
      await apiFetch('/api/inference/hardware/rescan', { method: 'POST', credentials: 'include' });
      await fetchProfile(true);
    } catch (e) {
      toast.error(`Rescan failed: ${(e as Error).message}`);
      setRescanning(false);
    }
  };

  const handleToggleModel = (modelId: string) => {
    setSelectedModelIds((prev) => (prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId]));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Save cloud providers — for already-configured providers (masked key),
      // always persist enabled state; for new/changed keys, send the full config.
      for (const cp of cloudProviders) {
        if (cp.apiKey.trim() && !cp.apiKey.startsWith('••')) {
          await apiFetch('/api/inference/cloud-providers', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: cp.provider, apiKey: cp.apiKey, enabled: cp.enabled }),
          });
        } else if (cp.apiKey.startsWith('••')) {
          // Already-configured provider — update enabled state without re-sending key
          await apiFetch('/api/inference/cloud-providers', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: cp.provider, enabled: cp.enabled }),
          });
        }
      }

      // Pull and pin newly selected models
      for (const modelId of selectedModelIds) {
        if (!pinnedModelIds.has(modelId)) {
          const pullRes = await apiFetch('/api/inference/models/pull', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId }),
          });
          if (pullRes.ok) {
            await apiFetch('/api/inference/models/pin', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ modelId }),
            });
          }
        }
      }

      // Unpin models that were deselected
      for (const modelId of pinnedModelIds) {
        if (!selectedModelIds.includes(modelId)) {
          await apiFetch('/api/inference/models/unpin', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId }),
          });
        }
      }

      toast.success('AI settings saved');
      // Refresh to show updated state
      await fetchProfile(true);
    } catch (e) {
      toast.error(`Failed to save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-xl">AI & Inference</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-4 py-4 text-center">
                <Loader2 role="img" aria-label="loading" className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">Detecting your hardware…</p>
              </div>
              <Skeleton className="h-24 w-full rounded-lg" />
              <Skeleton className="h-48 w-full rounded-lg" />
              <Skeleton className="h-32 w-full rounded-lg" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-xl">AI & Inference</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8">
              <p className="text-destructive mb-4">Failed to load AI settings: {error}</p>
              <Button variant="outline" onClick={() => fetchProfile()}>
                <RefreshCw className="mr-2" size={16} />
                Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isInsufficient = profile.tier === 'insufficient';
  const selectedModels = profile.availableModels.filter((m) => selectedModelIds.includes(m.id));
  const availableMemoryMb = profile.resourceEstimate.availableMemoryMb;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-xl">AI & Inference</CardTitle>
          </div>
          <CardDescription>Manage local AI models, inference backends, and cloud provider fallbacks.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <HardwareProfileCard hardware={profile.hardware} tier={profile.tier} onRescan={handleRescan} rescanning={rescanning} />

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

          <div className="flex justify-end pt-2">
            <Button intent="primary" onClick={handleSave} loading={saving} data-testid="ai-settings-save-btn">
              Save AI Settings
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
