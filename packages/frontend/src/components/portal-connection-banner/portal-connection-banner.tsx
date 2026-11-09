import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { isPortalCheckInFailing, isPortalRejected } from '@/lib/registration-status';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Hub-wide notice for a Hub that has lost its working link to Portal. Failing check-ins clear by
 * themselves, so that notice only says what is affected. A refused device key does not clear, so that
 * one names the command that fixes it: the pairing screen doesn't take a registered Hub for this reason.
 * The key can be refused for ten minutes before the Hub reports it, so one notice follows the other.
 */
export function PortalConnectionBanner() {
  const { t } = useTranslation();
  const { data: status } = useRegistrationStatus();

  if (!status) {
    return null;
  }

  const rejected = isPortalRejected(status);
  if (!rejected && !isPortalCheckInFailing(status)) {
    return null;
  }

  return (
    <Alert variant="warning" role="status" aria-live="polite" data-testid="portal-connection-banner">
      <AlertIcon>
        <AlertTriangle aria-hidden />
      </AlertIcon>
      <div>
        <AlertHeading>{t(rejected ? 'PORTAL_REJECTED_BANNER_TITLE' : 'PORTAL_CHECK_IN_FAILING_BANNER_TITLE')}</AlertHeading>
        <AlertDescription>{t(rejected ? 'PORTAL_REJECTED_BANNER_MESSAGE' : 'PORTAL_CHECK_IN_FAILING_BANNER_MESSAGE')}</AlertDescription>
      </div>
    </Alert>
  );
}
