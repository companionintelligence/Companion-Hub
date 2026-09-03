import type { InstallQueueState } from '@/modules/app/helpers/install-queue';
import { hasQueueActivity } from '@/modules/app/helpers/use-install-queue';
import { Clock, Loader2 } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';

interface QueuedInstallsIndicatorProps {
  queue: InstallQueueState | undefined;
  isLoading?: boolean;
}

export const QueuedInstallsIndicator = ({ queue, isLoading }: QueuedInstallsIndicatorProps) => {
  const { t } = useTranslation();

  if (isLoading && !hasQueueActivity(queue)) {
    return null;
  }

  if (!queue || !hasQueueActivity(queue)) {
    return null;
  }

  const waitingCount = queue.queued?.length ?? 0;
  const waitingNames = queue.queued?.map((e) => e.name).join(', ') ?? '';
  const activeOnly = Boolean(queue.active) && waitingCount === 0;

  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground"
      data-testid="queued-installs-indicator"
      role="status"
    >
      {activeOnly ? (
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-600" aria-hidden />
      ) : (
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      )}
      <div className="min-w-0">
        {activeOnly ? (
          <p>{t('INSTALL_QUEUE_ACTIVE_ONLY', { name: queue.active?.name })}</p>
        ) : queue.active ? (
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
        {waitingCount > 0 ? (
          <p className="mt-0.5 truncate text-xs" title={waitingNames}>
            {t('INSTALL_QUEUE_WAITING_NAMES', { names: waitingNames })}
          </p>
        ) : null}
      </div>
    </div>
  );
};
