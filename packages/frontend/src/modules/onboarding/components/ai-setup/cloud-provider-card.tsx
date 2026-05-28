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

export const CloudProviderCard = ({ providers, insufficientHardware, onUpdate }: CloudProviderCardProps) => {
  const [expanded, setExpanded] = useState(insufficientHardware);
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
            {PROVIDER_ORDER.map((type) => {
              const pattern = CLOUD_KEY_PATTERNS[type];
              const current = getProvider(type);
              const error = errors[type];

              return (
                <div key={type} data-testid={`cloud-provider-${type}`}>
                  <label className="text-xs font-medium" htmlFor={`cloud-key-input-${type}`}>
                    {pattern.label}
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
      </CardContent>
    </Card>
  );
};
