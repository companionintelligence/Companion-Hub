import { Alert, AlertDescription, AlertHeading, AlertIcon } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import type { AppDetails, AppInfo } from '@/types/app.types';
import { RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RestartDialog } from '../dialogs/restart-dialog/restart-dialog';

interface Props {
  info: AppInfo;
  app?: AppDetails | null;
  /** Whether this person may restart the app. Without it the notice still says what is owed. */
  canRestart: boolean;
}

/**
 * A running custom app whose configuration was saved keeps its old containers until it restarts (#2421).
 * The save raises `pendingRestart`, which Home shows as a "Restart needed" badge; this says the same on
 * the app's page and offers the restart through the usual Restart dialog. Start and restart clear it.
 */
export const CustomAppRestartNotice = ({ info, app, canRestart }: Props) => {
  const { t } = useTranslation();
  const restartDisclosure = useDisclosure();

  if (app?.status !== 'running' || !app.pendingRestart) {
    return null;
  }

  return (
    <>
      <Alert variant="info" role="status" data-testid="custom-app-restart-notice">
        <AlertIcon>
          <RotateCw strokeWidth={2} />
        </AlertIcon>
        <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <AlertHeading>{t('CUSTOM_APP_RESTART_NOTICE_TITLE')}</AlertHeading>
            <AlertDescription>{t('CUSTOM_APP_RESTART_NOTICE_BODY', { name: info.name })}</AlertDescription>
          </div>
          {canRestart ? (
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={restartDisclosure.open}>
              {t('COMMON_RESTART')}
            </Button>
          ) : null}
        </div>
      </Alert>
      <RestartDialog info={info} isOpen={restartDisclosure.isOpen} onClose={restartDisclosure.close} />
    </>
  );
};
