import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { client } from '@/api-client/client.gen';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import type React from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

interface IProps {
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
}

export const ForceStopDialog: React.FC<IProps> = ({ info, isOpen, onClose }) => {
  const { t } = useTranslation();
  const { setOptimisticStatus } = useAppStatus();

  const forceStopMutation = useMutation({
    mutationFn: () => client.post({ url: `/api/app-lifecycle/${encodeURIComponent(info.urn)}/force-stop` }),
    onError: (error: TranslatableError) => {
      toast.error(t(error.message, error.intlParams));
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
