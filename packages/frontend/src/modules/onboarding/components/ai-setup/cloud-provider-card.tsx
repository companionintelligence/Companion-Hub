import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import type { CloudProviderType } from '@ci-hub/common/types';
import { useState } from 'react';
import { type CloudProviderInput, CLOUD_KEY_PATTERNS, validateCloudKey } from '../../helpers/ai-setup-types';

interface CloudProviderCardProps {
  providers: CloudProviderInput[];
  insufficientHardware: boolean;
  onUpdate: (providers: CloudProviderInput[]) => void;
}

const PROVIDER_ORDER: CloudProviderType[] = ['openai', 'anthropic', 'google', 'github-copilot'];
const RECOMMENDED_PROVIDERS: CloudProviderType[] = ['openai', 'anthropic'];
const PROVIDER_PRESENTATION: Record<CloudProviderType, { title: string; subtitle?: string }> = {
  openai: { title: 'OpenClaude', subtitle: 'Recommended personal AI service' },
  anthropic: { title: 'Hermes', subtitle: 'Recommended personal AI service' },
  google: { title: 'Google AI' },
  'github-copilot': { title: 'GitHub Copilot' },
};

export const CloudProviderCard = ({ providers, insufficientHardware, onUpdate }: CloudProviderCardProps) => {
  const [expanded, setExpanded] = useState(insufficientHardware);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const getProvider = (type: CloudProviderType): CloudProviderInput =>
    providers.find((p) => p.provider === type) ?? { provider: type, apiKey: '', enabled: false };

  const handleKeyChange = (type: CloudProviderType, apiKey: string) => {
    const error = validateCloudKey(type, apiKey);
    setErrors((prev) => ({ ...prev, [type]: error }));

    const updated = [...providers];
    const idx = updated.findIndex((p) => p.provider === type);
    const entry: CloudProviderInput = { provider: type, apiKey, enabled: apiKey.trim().length > 0 };
    if (idx >= 0) {
      updated[idx] = entry;
    } else {
      updated.push(entry);
    }
    onUpdate(updated);
  };

  return (
    <Card>
      <CardContent className="p-4">
        {insufficientHardware ? (
          <>
            <h3 className="text-sm font-semibold mb-1" data-testid="cloud-card-title">
              Cloud AI Provider
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              Your hardware can't run local AI models. Configure a cloud provider to use AI features.
            </p>
          </>
        ) : (
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold" data-testid="cloud-card-title">
              Cloud Providers
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)} data-testid="cloud-toggle">
              {expanded ? 'Collapse' : 'Add cloud providers (optional)'}
            </Button>
          </div>
        )}

        {(expanded || insufficientHardware) && (
          <div className="space-y-3" data-testid="cloud-inputs">
            {RECOMMENDED_PROVIDERS.map((type) => {
              const pattern = CLOUD_KEY_PATTERNS[type];
              const presentation = PROVIDER_PRESENTATION[type];
              const current = getProvider(type);
              const error = errors[type];

              return (
                <div key={type} className="rounded-xl border-2 border-primary/40 bg-primary/5 p-4" data-testid={`cloud-provider-${type}`}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <label className="text-sm font-semibold" htmlFor={`cloud-key-input-${type}`}>
                        {presentation.title}
                      </label>
                      {presentation.subtitle && <p className="text-xs text-muted-foreground">{presentation.subtitle}</p>}
                    </div>
                    <span className="rounded-full bg-primary/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                      Recommended
                    </span>
                  </div>
                  <Input
                    id={`cloud-key-input-${type}`}
                    type="password"
                    placeholder={pattern.prefix ? `${pattern.prefix}...` : 'API key'}
                    value={current.apiKey}
                    onChange={(e) => handleKeyChange(type, e.target.value)}
                    className="mt-1"
                    data-testid={`cloud-key-${type}`}
                  />
                  {error && (
                    <p className="text-xs text-destructive mt-1" data-testid={`cloud-error-${type}`}>
                      {error}
                    </p>
                  )}
                </div>
              );
            })}

            <div className="rounded-lg border border-dashed border-muted-foreground/30 p-3">
              <Button variant="ghost" size="sm" onClick={() => setOtherExpanded(!otherExpanded)} data-testid="other-services-toggle">
                {otherExpanded ? 'Hide other AI services' : 'Other AI services'}
              </Button>

              {otherExpanded && (
                <div className="mt-3 space-y-3">
                  {PROVIDER_ORDER.filter((type) => !RECOMMENDED_PROVIDERS.includes(type)).map((type) => {
                    const pattern = CLOUD_KEY_PATTERNS[type];
                    const presentation = PROVIDER_PRESENTATION[type];
                    const current = getProvider(type);
                    const error = errors[type];

                    return (
                      <div key={type} className="rounded-lg border border-muted/70 p-3 opacity-85" data-testid={`cloud-provider-${type}`}>
                        <label className="text-xs font-medium" htmlFor={`cloud-key-input-${type}`}>
                          {presentation.title}
                        </label>
                        <Input
                          id={`cloud-key-input-${type}`}
                          type="password"
                          placeholder={pattern.prefix ? `${pattern.prefix}...` : 'API key'}
                          value={current.apiKey}
                          onChange={(e) => handleKeyChange(type, e.target.value)}
                          className="mt-1"
                          data-testid={`cloud-key-${type}`}
                        />
                        {error && (
                          <p className="text-xs text-destructive mt-1" data-testid={`cloud-error-${type}`}>
                            {error}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
