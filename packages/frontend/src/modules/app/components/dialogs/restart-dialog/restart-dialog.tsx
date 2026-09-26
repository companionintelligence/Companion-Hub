import { restartAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { invalidateAppQueries } from '@/modules/app/helpers/app-sse-cache';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

interface IProps {
  /** Only the two fields this dialog reads, so a caller holding a report entry needs no full AppInfo. */
  info: Pick<AppInfo, 'urn' | 'name'>;
  isOpen: boolean;
  onClose: () => void;
  /** Why the restart is being offered, shown above the standard line — e.g. the domain it will start serving. */
  reason?: string;
}
export const RestartDialog: React.FC<IProps> = ({ info, isOpen, onClose, reason }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { setOptimisticStatus } = useAppStatus();

  const restartMutation = useMutation({
    ...restartAppMutation(),
    onError: (e: TranslatableError) => {
      toast.error(t(e.message, e.intlParams));
      // A pre-flight rejection (e.g. restarting an app that was just removed) fails
      // synchronously and emits no lifecycle SSE event, and nothing polls the app
      // detail — so without this the optimistic 'restarting' status would spin
      // forever. Re-sync from the server to clear it (#909).
      invalidateAppQueries(queryClient, info.urn);
    },
    onMutate: () => {
      setOptimisticStatus('restarting', info.urn);
      onClose();
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('APP_RESTART_FORM_TITLE', { name: info.name })}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {reason ? <span className="block mb-2">{reason}</span> : null}
          <span className="text-muted-foreground">{t('COMMON_ALL_DATA_RETAINED')}</span>
        </DialogDescription>
        <DialogFooter>
          <Button onClick={() => restartMutation.mutate({ path: { urn: info.urn } })} intent="danger">
            {t('COMMON_RESTART')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
