import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { isPortalUnreachable } from '@/lib/registration-status';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Hub-wide notice for a Hub that has lost contact with Portal. Nothing here can fix it and the Hub
 * retries by itself, so it only says what is affected. It goes away with the next check-in that works.
 */
export function PortalUnreachableBanner() {
  const { t } = useTranslation();
  const { data: status } = useRegistrationStatus();

  if (!status || !isPortalUnreachable(status)) {
    return null;
  }

  return (
    <Alert variant="warning" role="status" aria-live="polite" data-testid="portal-unreachable-banner">
      <AlertIcon>
        <AlertTriangle aria-hidden />
      </AlertIcon>
      <div>
        <AlertHeading>{t('PORTAL_UNREACHABLE_BANNER_TITLE')}</AlertHeading>
        <AlertDescription>{t('PORTAL_UNREACHABLE_BANNER_MESSAGE')}</AlertDescription>
      </div>
    </Alert>
  );
}
