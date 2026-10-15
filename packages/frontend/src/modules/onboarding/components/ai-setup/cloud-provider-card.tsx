import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { isMaskedKey } from '@/lib/inference/masked-key';
import type { CloudProviderType } from '@ci-hub/common/types';
import { useState } from 'react';
import { type CloudProviderInput, CLOUD_KEY_PATTERNS, validateCloudKey } from '../../helpers/ai-setup-types';
import { BrandLogo } from './icons';
import { Trans, useTranslation } from 'react-i18next';

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
 *
 * A provider set to another server (`baseUrl`) shows that URL, because a key saved here goes there.
 * Without a stored key it says it needs one. Remove then deletes its settings, URL included.
 */
export const CloudProviderCard = ({ providers, insufficientHardware, onUpdate }: CloudProviderCardProps) => {
  const { t } = useTranslation();
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const getProvider = (type: CloudProviderType): CloudProviderInput =>
    providers.find((p) => p.provider === type) ?? { provider: type, apiKey: '', enabled: false };

  const replaceProvider = (entry: CloudProviderInput) => {
    const updated = [...providers];
    const idx = updated.findIndex((p) => p.provider === entry.provider);
    if (idx >= 0) {
      updated[idx] = entry;
    } else {
      updated.push(entry);
    }
    onUpdate(updated);
  };

  const handleKeyChange = (type: CloudProviderType, apiKey: string) => {
    const error = validateCloudKey(type, apiKey);
    setErrors((prev) => ({ ...prev, [type]: error }));

    // A stored key stays marked as stored when the field is edited, so clearing it removes the key
    // on save instead of leaving it on the Hub. The URL stays too: the key is saved for it.
    const { stored, baseUrl } = getProvider(type);
    replaceProvider({ provider: type, apiKey, enabled: apiKey.trim().length > 0, ...(stored ? { stored } : {}), ...(baseUrl ? { baseUrl } : {}) });
  };

  // A provider with no stored key has an empty field already, so it needs its own mark for Save.
  const handleRemove = (type: CloudProviderType) => {
    const current = getProvider(type);
    if (current.stored) {
      handleKeyChange(type, '');
      return;
    }
    setErrors((prev) => ({ ...prev, [type]: null }));
    replaceProvider({ ...current, apiKey: '', enabled: false, removed: true });
  };

  return (
    <div className="space-y-3" data-testid="cloud-inputs">
      {insufficientHardware && <p className="text-xs text-muted-foreground">{t('ONBOARDING_CLOUD_PROVIDER_REQUIRED_HINT')}</p>}

      {PROVIDER_ORDER.map((type) => {
        const pattern = CLOUD_KEY_PATTERNS[type];
        const current = getProvider(type);
        const error = errors[type];
        const removing = (current.stored === true && current.apiKey.trim() === '') || current.removed === true;
        const keyTyped = current.apiKey.trim() !== '' && !isMaskedKey(current.apiKey);
        const needsKey = !current.stored && !!current.baseUrl && !removing && !keyTyped;
        const status = current.stored
          ? t(current.enabled ? 'AI_SETTINGS_CLOUD_KEY_ON' : 'AI_SETTINGS_CLOUD_KEY_OFF')
          : t(needsKey ? 'AI_SETTINGS_CLOUD_KEY_NEEDED' : 'ONBOARDING_OPTIONAL');
        const urlCopy = keyTyped ? 'AI_SETTINGS_CLOUD_KEY_SENT_TO' : needsKey ? 'AI_SETTINGS_CLOUD_URL_NEEDS_KEY' : 'AI_SETTINGS_CLOUD_URL';
        const removedCopy = current.baseUrl
          ? current.stored
            ? 'AI_SETTINGS_CLOUD_KEY_AND_URL_REMOVED_ON_SAVE'
            : 'AI_SETTINGS_CLOUD_URL_REMOVED_ON_SAVE'
          : 'AI_SETTINGS_CLOUD_KEY_REMOVED_ON_SAVE';

        return (
          <div key={type} className="rounded-md border border-primary/40 bg-primary/[0.06] p-4" data-testid={`cloud-provider-${type}`}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm font-semibold" htmlFor={`cloud-key-input-${type}`}>
                <BrandLogo name={PROVIDER_BRAND[type]} className="h-4 w-4 text-foreground/80" />
                {PROVIDER_TITLE[type]}
              </label>
              <span
                className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                  needsKey
                    ? 'bg-warning/10 text-warning'
                    : current.stored && !current.enabled
                      ? 'bg-muted text-muted-foreground'
                      : 'bg-primary/15 text-primary'
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
              {(current.stored || current.baseUrl) && !removing && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleRemove(type)}
                  aria-label={t(current.stored ? 'AI_SETTINGS_CLOUD_KEY_REMOVE_LABEL' : 'AI_SETTINGS_CLOUD_URL_REMOVE_LABEL', {
                    provider: PROVIDER_TITLE[type],
                  })}
                  data-testid={`cloud-key-remove-${type}`}
                >
                  {t('AI_SETTINGS_CLOUD_KEY_REMOVE')}
                </Button>
              )}
            </div>
            {current.baseUrl && !removing && (
              <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid={`cloud-base-url-${type}`}>
                {/* The URL is the span's own text, never parsed by Trans as markup. */}
                <Trans i18nKey={urlCopy} components={{ url: <span className="font-mono text-foreground">{current.baseUrl}</span> }} />
              </p>
            )}
            {removing && (
              <p className="text-xs text-muted-foreground mt-1" data-testid={`cloud-key-removing-${type}`}>
                {t(removedCopy, { provider: PROVIDER_TITLE[type] })}
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
