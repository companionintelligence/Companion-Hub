import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import type { FormField } from '@/types/app.types';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { InstallMode } from './install-mode-selector';
import { formatCpuReadout, formatMemoryReadout, parseMemoryLimitToMb } from './resource-limits-helpers';
import { HIDDEN_FIELD_TYPES } from '@ci-hub/common/validation';

const isHiddenFieldType = (type: FormField['type']) => HIDDEN_FIELD_TYPES.includes(type as (typeof HIDDEN_FIELD_TYPES)[number]);

interface IProps {
  appName: string;
  installMode: InstallMode;
  formFields: FormField[];
  values: Record<string, unknown>;
  cpuLimit?: string;
  memoryLimit?: string;
}

const maskedTypes = new Set(['password']);

function readableValue(field: FormField, raw: unknown): string {
  if (maskedTypes.has(field.type)) {
    const asString = raw === undefined || raw === null ? '' : String(raw);
    return asString ? '•'.repeat(Math.min(asString.length, 12)) : '—';
  }
  if (raw === undefined || raw === null || raw === '') {
    const fallback = field.default;
    return fallback === undefined || fallback === null || fallback === '' ? '—' : String(fallback);
  }
  if (typeof raw === 'boolean') return raw ? 'on' : 'off';
  return String(raw);
}

/**
 * Read-only, live-updating summary of what will actually be installed — resolved env values plus
 * resource limits — mirroring community-scripts.org/generator's "Install Command" sidebar so the
 * operator can see the effect of the wizard before committing.
 */
export const InstallPreviewPanel: React.FC<IProps> = ({ appName, installMode, formFields, values, cpuLimit, memoryLimit }) => {
  const { t } = useTranslation();

  const visibleFields = formFields.filter((field) => !isHiddenFieldType(field.type));
  const modeLabelKey =
    installMode === 'manual'
      ? 'APP_INSTALL_FORM_MODE_MANUAL'
      : installMode === 'recommended'
        ? 'APP_INSTALL_FORM_MODE_RECOMMENDED'
        : 'APP_INSTALL_FORM_MODE_APP_DEFAULTS';

  return (
    <Card className="bg-muted/10">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold tracking-wide text-foreground">{t('APP_INSTALL_FORM_PREVIEW_TITLE')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0 text-sm">
        <dl className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t('APP_INSTALL_FORM_PREVIEW_APP_LABEL')}</dt>
            <dd className="truncate font-medium text-foreground">{appName}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t('APP_INSTALL_FORM_INSTALL_MODE')}</dt>
            <dd className="truncate font-medium text-foreground">{t(modeLabelKey)}</dd>
          </div>
        </dl>

        <div className="space-y-1.5 border-t border-border/60 pt-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('APP_INSTALL_FORM_RESOURCE_LIMITS')}</div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t('APP_INSTALL_FORM_CPU_LIMIT')}</dt>
            <dd className="font-medium text-foreground">{cpuLimit ? formatCpuReadout(Number(cpuLimit)) : t('APP_INSTALL_FORM_RESOURCE_AUTO')}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t('APP_INSTALL_FORM_MEMORY_LIMIT')}</dt>
            <dd className="font-medium text-foreground">
              {/* Compose-style string (e.g. "2048M", "4g") — parse via the unit-aware helper, not a
                  bare parseInt, or "4g" would silently read as 4 MB instead of 4096 MB. */}
              {memoryLimit ? formatMemoryReadout(parseMemoryLimitToMb(memoryLimit) ?? 0) : t('APP_INSTALL_FORM_RESOURCE_AUTO')}
            </dd>
          </div>
        </div>

        {visibleFields.length > 0 && (
          <div className="space-y-1.5 border-t border-border/60 pt-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('APP_INSTALL_FORM_PREVIEW_CONFIG')}</div>
            <dl className="space-y-1.5">
              {visibleFields.map((field) => (
                <div key={field.env_variable} className="flex items-center justify-between gap-2">
                  <dt className="min-w-0 truncate text-muted-foreground" title={field.env_variable}>
                    {field.label}
                  </dt>
                  <dd
                    className="min-w-0 max-w-[60%] truncate text-right font-mono text-xs text-foreground"
                    title={readableValue(field, values[field.env_variable])}
                  >
                    {readableValue(field, values[field.env_variable])}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
