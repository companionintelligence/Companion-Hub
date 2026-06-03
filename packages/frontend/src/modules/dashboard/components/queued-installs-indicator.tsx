import type { InstallQueueState } from '@/modules/app/helpers/install-queue';
import { Clock } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';

interface QueuedInstallsIndicatorProps {
  queue: InstallQueueState | undefined;
  isLoading?: boolean;
}

export const QueuedInstallsIndicator = ({ queue, isLoading }: QueuedInstallsIndicatorProps) => {
  const { t } = useTranslation();

  if (isLoading || !queue || (queue.queued?.length ?? 0) === 0) {
    return null;
  }

  const waitingCount = queue.queued.length;
  const waitingNames = queue.queued.map((e) => e.name).join(', ');

  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground"
      data-testid="queued-installs-indicator"
      role="status"
    >
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      <div className="min-w-0">
        {queue.active ? (
          <p>
            <Trans
              i18nKey="INSTALL_QUEUE_ACTIVE_AND_WAITING"
              values={{ activeName: queue.active.name, count: waitingCount }}
              components={{ strong: <strong className="font-medium text-foreground" /> }}
            />
          </p>
        ) : (
          <p>{t('INSTALL_QUEUE_WAITING_ONLY', { count: waitingCount })}</p>
        )}
        <p className="mt-0.5 truncate text-xs" title={waitingNames}>
          {t('INSTALL_QUEUE_WAITING_NAMES', { names: waitingNames })}
        </p>
      </div>
    </div>
  );
};
