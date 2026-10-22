import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import type { AppRuntimeHealth } from '@/lib/app-runtime-monitor';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function AppRuntimeDegradedBanner({ runtimeHealth, className }: { runtimeHealth?: AppRuntimeHealth | null; className?: string }) {
  const { t } = useTranslation();

  if (!runtimeHealth?.degraded) {
    return null;
  }

  return (
    <Alert variant="warning" data-testid="app-runtime-degraded-banner" className={className}>
      <AlertIcon>
        <AlertTriangle aria-hidden />
      </AlertIcon>
      <div>
        <AlertHeading>{t('APP_RUNTIME_DEGRADED_TITLE', { appName: runtimeHealth.appName })}</AlertHeading>
        <AlertDescription>{runtimeHealth.reason || t('APP_RUNTIME_DEGRADED_SUBTITLE')}</AlertDescription>
      </div>
    </Alert>
  );
}
