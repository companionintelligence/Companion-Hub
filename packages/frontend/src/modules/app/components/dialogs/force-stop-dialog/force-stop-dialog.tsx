import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { client } from '@/api-client/client.gen';
import { formatApiError } from '@/lib/format-api-error';
import { invalidateAppQueries } from '@/modules/app/helpers/app-sse-cache';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import type { AppInfo } from '@/types/app.types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

interface IProps {
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
}

export const ForceStopDialog: React.FC<IProps> = ({ info, isOpen, onClose }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { setOptimisticStatus } = useAppStatus();

  const forceStopMutation = useMutation({
    // throwOnError: the generated client resolves on a non-2xx, so a refused force-stop would never reach onError.
    mutationFn: () => client.post({ url: `/api/app-lifecycle/${encodeURIComponent(info.urn)}/force-stop`, throwOnError: true }),
    onError: (error: unknown) => {
      // formatApiError, not t(error.message): a network failure or raw backend English reaches here
      // now that the call rejects, and neither belongs on screen verbatim.
      toast.error(formatApiError(error, t));
      // A pre-flight rejection (e.g. force-stopping an app that was just removed)
      // fails synchronously and emits no lifecycle SSE event, and nothing polls the
      // app detail — so without this the optimistic 'stopping' status would spin
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
          <DialogTitle>{t('APP_FORCE_STOP_FORM_TITLE', { name: info.name })}</DialogTitle>
        </DialogHeader>
        <DialogDescription>{t('APP_FORCE_STOP_FORM_SUBTITLE')}</DialogDescription>
        <DialogFooter>
          <Button onClick={() => forceStopMutation.mutate()} intent="danger">
            {t('APP_FORCE_STOP_ACTION')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
