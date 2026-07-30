import clsx from 'clsx';
import type React from 'react';
import { useTranslation } from 'react-i18next';

export type InstallMode = 'manual' | 'recommended' | 'appDefaults';

interface IProps {
  value: InstallMode;
  onChange: (mode: InstallMode) => void;
  disabled?: boolean;
}

/**
 * Top-of-form mode selector, styled after the exposure-mode segmented control below it.
 * Drives where the resource sliders (and their bounds) pull their numbers from — see
 * resource-limits-section.tsx.
 */
export const InstallModeSelector: React.FC<IProps> = ({ value, onChange, disabled }) => {
  const { t } = useTranslation();

  const options = [
    { key: 'manual' as const, label: t('APP_INSTALL_FORM_MODE_MANUAL'), hint: t('APP_INSTALL_FORM_MODE_MANUAL_HINT') },
    { key: 'recommended' as const, label: t('APP_INSTALL_FORM_MODE_RECOMMENDED'), hint: t('APP_INSTALL_FORM_MODE_RECOMMENDED_HINT') },
    { key: 'appDefaults' as const, label: t('APP_INSTALL_FORM_MODE_APP_DEFAULTS'), hint: t('APP_INSTALL_FORM_MODE_APP_DEFAULTS_HINT') },
  ];

  return (
    <div className="mb-3">
      <span className="block text-sm font-medium mb-1">{t('APP_INSTALL_FORM_INSTALL_MODE')}</span>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={value === option.key}
            disabled={disabled}
            onClick={() => onChange(option.key)}
            className={clsx(
              'w-full rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors',
              value === option.key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
              disabled && 'opacity-50 cursor-not-allowed hover:bg-white dark:hover:bg-gray-800',
            )}
          >
            <div>{option.label}</div>
            <div className={clsx('mt-0.5 text-xs font-normal', value === option.key ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
              {option.hint}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};
