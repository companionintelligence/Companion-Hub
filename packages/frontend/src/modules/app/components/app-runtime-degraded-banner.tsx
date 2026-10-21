import { Alert, AlertDescription, AlertHeading } from '@/components/ui/Alert/Alert';
import type { AppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { cn } from '@/lib/utils';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Styled like the Hub's other warning banners (`TunnelStatusBanner`, the pool setup card): `Alert`'s
 * own `alert-warning` class has no stylesheet, so on its own the banner rendered as bare text.
 */
export function AppRuntimeDegradedBanner({ runtimeHealth, className }: { runtimeHealth?: AppRuntimeHealth | null; className?: string }) {
  const { t } = useTranslation();

  if (!runtimeHealth?.degraded) {
    return null;
  }

  return (
    <Alert
      variant="warning"
      data-testid="app-runtime-degraded-banner"
      className={cn('flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm shadow-sm', className)}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <div className="leading-relaxed">
        <AlertHeading className="font-semibold text-warning">{t('APP_RUNTIME_DEGRADED_TITLE', { appName: runtimeHealth.appName })}</AlertHeading>
        <AlertDescription className="text-muted-foreground">{runtimeHealth.reason || t('APP_RUNTIME_DEGRADED_SUBTITLE')}</AlertDescription>
      </div>
    </Alert>
  );
}
