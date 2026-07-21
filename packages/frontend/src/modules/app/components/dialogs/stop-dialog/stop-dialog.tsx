import { stopAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { invalidateAppQueries } from '@/modules/app/helpers/app-sse-cache';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

interface IProps {
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
}

export const StopDialog: React.FC<IProps> = ({ info, isOpen, onClose }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { setOptimisticStatus } = useAppStatus();

  const stopMutation = useMutation({
    ...stopAppMutation(),
    onError: (error: TranslatableError) => {
      toast.error(t(error.message, error.intlParams));
      // A pre-flight rejection (e.g. stopping an app that was just removed) fails
      // synchronously and emits no lifecycle SSE event, and nothing polls the app
      // detail — so without this the optimistic 'stopping' status would spin
      // forever. Re-sync from the server to clear it (#909).
      invalidateAppQueries(queryClient, info.urn);
    },
    onMutate: () => {
      setOptimisticStatus('stopping', info.urn);
      onClose();
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('APP_STOP_FORM_TITLE', { name: info.name })}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <span className="text-muted">{t('COMMON_ALL_DATA_RETAINED')}</span>
        </DialogDescription>
        <DialogFooter>
          <Button onClick={() => stopMutation.mutate({ path: { urn: info.urn } })} intent="danger">
            {t('COMMON_STOP')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
