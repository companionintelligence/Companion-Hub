import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { useHubAccess } from '@/lib/hooks/use-hub-access';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { isPortalCheckInFailing, isPortalRejected } from '@/lib/registration-status';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Outside the translated message, so no translation can change what a person types.
const RE_PAIR_COMMAND = 'cihub register --code <code>';

/**
 * Hub-wide notice for a Hub that has lost its working link to Portal. Failing check-ins usually clear
 * by themselves, so that notice only says what is affected. A body Portal refuses lasts until one side
 * updates, but the status can't tell that case apart. A refused device key does not clear, so that one
 * names the command that fixes it: the pairing screen doesn't take a registered Hub for this reason.
 * The key can be refused for ten minutes before the Hub reports it, so one notice follows the other.
 */
export function PortalConnectionBanner() {
  const { t } = useTranslation();
  const { data: status } = useRegistrationStatus();
  const rejected = Boolean(status && isPortalRejected(status));
  const failing = Boolean(status && isPortalCheckInFailing(status));
  // Pairing again is an owner's or admin's to do, so a member sees the notice only. Asked only while it can matter.
  const { manageHub } = useHubAccess({ enabled: rejected });

  if (!rejected && !failing) {
    return null;
  }

  const notice = rejected
    ? { title: 'PORTAL_REJECTED_BANNER_TITLE', message: manageHub ? 'PORTAL_REJECTED_BANNER_MESSAGE' : 'PORTAL_REJECTED_BANNER_MEMBER_MESSAGE' }
    : { title: 'PORTAL_CHECK_IN_FAILING_BANNER_TITLE', message: 'PORTAL_CHECK_IN_FAILING_BANNER_MESSAGE' };

  return (
    <Alert variant="warning" role="status" aria-live="polite" data-testid="portal-connection-banner">
      <AlertIcon>
        <AlertTriangle aria-hidden />
      </AlertIcon>
      <div>
        <AlertHeading>{t(notice.title)}</AlertHeading>
        <AlertDescription>
          {t(notice.message)}
          {rejected && manageHub && <code className="mt-1 block select-all rounded bg-muted px-2 py-1 font-mono text-xs">{RE_PAIR_COMMAND}</code>}
        </AlertDescription>
      </div>
    </Alert>
  );
}
