import { Slider } from '@/components/ui/Slider';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { Control } from 'react-hook-form';
import { Controller } from 'react-hook-form';
import type { FormValues } from './install-form';
import type { InstallMode } from './install-mode-selector';
import {
  CPU_LIMIT_FALLBACK_DEFAULT,
  CPU_LIMIT_FALLBACK_MAX,
  CPU_LIMIT_MIN,
  CPU_LIMIT_STEP,
  MEMORY_LIMIT_FALLBACK_DEFAULT_MB,
  MEMORY_LIMIT_FALLBACK_MAX_MB,
  MEMORY_LIMIT_MIN_MB,
  MEMORY_LIMIT_STEP_MB,
  formatCpuLimit,
  formatCpuReadout,
  formatMemoryLimitMb,
  formatMemoryReadout,
} from './resource-limits-helpers';

export interface ResourceDefaults {
  /** Docker daemon's own view of what's available — bounds the sliders. */
  cpuCoresAvailable?: number;
  memMbAvailable?: number;
  /** The backend's computed/effective recommendation (getEffectiveAppDefaults()). */
  recommendedCpuLimit?: string;
  recommendedMemoryLimit?: string;
  loading?: boolean;
}

interface IProps {
  control: Control<FormValues>;
  mode: InstallMode;
  defaults: ResourceDefaults;
}

/**
 * CPU + memory sliders, replacing the old plain-text CPU input. Bounds come from what Docker
 * actually has (packages/backend/.../resource-allocator.service.ts#getDockerCapacity); the
 * starting value and "Default" caption come from getEffectiveAppDefaults(). In "App defaults"
 * mode the sliders are disabled and the form omits cpuLimit/memoryLimit entirely so the backend's
 * own precedence chain (compose.builder.ts) picks the value at install time.
 */
export const ResourceLimitsSection: React.FC<IProps> = ({ control, mode, defaults }) => {
  const { t } = useTranslation();

  const cpuMax = defaults.cpuCoresAvailable && defaults.cpuCoresAvailable > 0 ? defaults.cpuCoresAvailable : CPU_LIMIT_FALLBACK_MAX;
  const memMax = defaults.memMbAvailable && defaults.memMbAvailable > 0 ? defaults.memMbAvailable : MEMORY_LIMIT_FALLBACK_MAX_MB;

  const recommendedCpu = Number(defaults.recommendedCpuLimit) || CPU_LIMIT_FALLBACK_DEFAULT;
  const recommendedMemMb = Number.parseInt(defaults.recommendedMemoryLimit ?? '', 10) || MEMORY_LIMIT_FALLBACK_DEFAULT_MB;

  const disabled = mode === 'appDefaults';

  return (
    <div className="mb-4 space-y-4 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="text-sm font-medium text-foreground">{t('APP_INSTALL_FORM_RESOURCE_LIMITS')}</div>

      <Controller
        control={control}
        name="cpuLimit"
        render={({ field: { onChange, value } }) => {
          const numeric = Number(value) || recommendedCpu;
          return (
            <Slider
              name="cpuLimit"
              label={t('APP_INSTALL_FORM_CPU_LIMIT')}
              valueLabel={disabled ? t('APP_INSTALL_FORM_RESOURCE_AUTO') : formatCpuReadout(numeric)}
              caption={t('APP_INSTALL_FORM_RESOURCE_DEFAULT_CAPTION', { value: formatCpuReadout(recommendedCpu) })}
              min={CPU_LIMIT_MIN}
              max={cpuMax}
              step={CPU_LIMIT_STEP}
              disabled={disabled}
              value={[disabled ? recommendedCpu : numeric]}
              onValueChange={([next]) => {
                if (next === undefined) return;
                onChange(formatCpuLimit(next));
              }}
            />
          );
        }}
      />

      <Controller
        control={control}
        name="memoryLimit"
        render={({ field: { onChange, value } }) => {
          const stringValue = typeof value === 'string' ? value : undefined;
          const parsed = Number.parseInt(stringValue ?? '', 10);
          const numeric = Number.isFinite(parsed) && stringValue ? parsed : recommendedMemMb;
          return (
            <Slider
              name="memoryLimit"
              label={t('APP_INSTALL_FORM_MEMORY_LIMIT')}
              valueLabel={disabled ? t('APP_INSTALL_FORM_RESOURCE_AUTO') : formatMemoryReadout(numeric)}
              caption={t('APP_INSTALL_FORM_RESOURCE_DEFAULT_CAPTION', { value: formatMemoryReadout(recommendedMemMb) })}
              min={MEMORY_LIMIT_MIN_MB}
              max={memMax}
              step={MEMORY_LIMIT_STEP_MB}
              disabled={disabled}
              value={[disabled ? recommendedMemMb : numeric]}
              onValueChange={([next]) => {
                if (next === undefined) return;
                onChange(formatMemoryLimitMb(next));
              }}
            />
          );
        }}
      />
    </div>
  );
};
