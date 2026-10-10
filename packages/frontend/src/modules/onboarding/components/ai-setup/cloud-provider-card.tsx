import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { CloudProviderType } from '@ci-hub/common/types';
import { useState } from 'react';
import { type CloudProviderInput, CLOUD_KEY_PATTERNS, validateCloudKey } from '../../helpers/ai-setup-types';
import { BrandLogo } from './icons';
import { useTranslation } from 'react-i18next';

interface CloudProviderCardProps {
  providers: CloudProviderInput[];
  insufficientHardware: boolean;
  onUpdate: (providers: CloudProviderInput[]) => void;
}

const PROVIDER_ORDER: CloudProviderType[] = ['openai', 'anthropic', 'google', 'github-copilot'];
const PROVIDER_TITLE: Record<CloudProviderType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google AI',
  'github-copilot': 'GitHub Copilot',
};
const PROVIDER_BRAND: Record<CloudProviderType, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  'github-copilot': 'githubcopilot',
};

/**
 * Cloud provider API-key inputs, rendered inside the "Cloud API Keys" advanced step. All providers
 * (OpenAI, Anthropic, Google, GitHub Copilot) are listed together — none are hidden behind a toggle.
 * When the hardware can't run local models, shows guidance to configure a provider.
 *
 * In Settings a provider can already hold a key (`stored`). It then says whether the Hub uses the
 * key (On or Off) and offers Remove; a stored key cleared either way is deleted when Settings saves.
 */
export const CloudProviderCard = ({ providers, insufficientHardware, onUpdate }: CloudProviderCardProps) => {
  const { t } = useTranslation();
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const getProvider = (type: CloudProviderType): CloudProviderInput =>
    providers.find((p) => p.provider === type) ?? { provider: type, apiKey: '', enabled: false };

  const handleKeyChange = (type: CloudProviderType, apiKey: string) => {
    const error = validateCloudKey(type, apiKey);
    setErrors((prev) => ({ ...prev, [type]: error }));

    const updated = [...providers];
    const idx = updated.findIndex((p) => p.provider === type);
    // A stored key stays marked as stored when the field is edited, so clearing it removes the key
    // on save instead of leaving it on the Hub.
    const stored = idx >= 0 && updated[idx]?.stored === true;
    const entry: CloudProviderInput = { provider: type, apiKey, enabled: apiKey.trim().length > 0, ...(stored ? { stored } : {}) };
    if (idx >= 0) {
      updated[idx] = entry;
    } else {
      updated.push(entry);
    }
    onUpdate(updated);
  };

  return (
    <div className="space-y-3" data-testid="cloud-inputs">
      {insufficientHardware && <p className="text-xs text-muted-foreground">{t('ONBOARDING_CLOUD_PROVIDER_REQUIRED_HINT')}</p>}

      {PROVIDER_ORDER.map((type) => {
        const pattern = CLOUD_KEY_PATTERNS[type];
        const current = getProvider(type);
        const error = errors[type];
        const removing = current.stored === true && current.apiKey.trim() === '';
        const status = current.stored ? t(current.enabled ? 'AI_SETTINGS_CLOUD_KEY_ON' : 'AI_SETTINGS_CLOUD_KEY_OFF') : t('ONBOARDING_OPTIONAL');

        return (
          <div key={type} className="rounded-md border border-primary/40 bg-primary/[0.06] p-4" data-testid={`cloud-provider-${type}`}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm font-semibold" htmlFor={`cloud-key-input-${type}`}>
                <BrandLogo name={PROVIDER_BRAND[type]} className="h-4 w-4 text-foreground/80" />
                {PROVIDER_TITLE[type]}
              </label>
              <span
                className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                  current.stored && !current.enabled ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary'
                }`}
              >
                {status}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Input
                id={`cloud-key-input-${type}`}
                type="password"
                placeholder={pattern.prefix ? `${pattern.prefix}...` : t('ONBOARDING_API_KEY')}
                value={current.apiKey}
                onChange={(e) => handleKeyChange(type, e.target.value)}
                className="min-w-0 flex-1"
                data-testid={`cloud-key-${type}`}
              />
              {current.stored && !removing && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleKeyChange(type, '')}
                  aria-label={t('AI_SETTINGS_CLOUD_KEY_REMOVE_LABEL', { provider: PROVIDER_TITLE[type] })}
                  data-testid={`cloud-key-remove-${type}`}
                >
                  {t('AI_SETTINGS_CLOUD_KEY_REMOVE')}
                </Button>
              )}
            </div>
            {removing && (
              <p className="text-xs text-muted-foreground mt-1" data-testid={`cloud-key-removing-${type}`}>
                {t('AI_SETTINGS_CLOUD_KEY_REMOVED_ON_SAVE')}
              </p>
            )}
            {error && (
              <p className="text-xs text-destructive mt-1" data-testid={`cloud-error-${type}`}>
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};
