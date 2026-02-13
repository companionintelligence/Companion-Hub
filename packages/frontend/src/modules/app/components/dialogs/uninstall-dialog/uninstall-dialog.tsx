import { uninstallAppMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Switch } from '@/components/ui/Switch';
import { useAppStatus } from '@/modules/app/helpers/use-app-status';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { AlertTriangle } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

interface IProps {
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
}

export const UninstallDialog = ({ info, isOpen, onClose }: IProps) => {
  const { t } = useTranslation();
  const { setOptimisticStatus } = useAppStatus();

  const [shouldRemoveBackups, setShouldRemoveBackups] = useState(false);

  const uninstallMutation = useMutation({
    ...uninstallAppMutation(),
    onError: (error: TranslatableError) => {
      toast.error(t(error.message, error.intlParams));
    },
    onMutate: () => {
      setOptimisticStatus('uninstalling', info.urn);
      onClose();
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent type="danger" size="sm">
        <DialogHeader>
          <DialogTitle>{t('APP_UNINSTALL_FORM_TITLE', { name: info.name })}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-center py-4">
          <AlertTriangle className="mb-2 text-destructive size-12 mx-auto" />
          <h3>{t('APP_UNINSTALL_FORM_WARNING')}</h3>
          <span className="text-muted-foreground">{t('APP_UNINSTALL_FORM_SUBTITLE')}</span>
          <div className="flex justify-center pt-3">
            <Switch
              className="text-start"
              checked={shouldRemoveBackups}
              onCheckedChange={setShouldRemoveBackups}
              label={t('APP_UNINSTALL_FORM_REMOVE_BACKUPS')}
            />
          </div>
        </DialogDescription>
        <DialogFooter>
          <Button onClick={() => uninstallMutation.mutate({ path: { urn: info.urn }, body: { removeBackups: shouldRemoveBackups } })} intent="danger">
            {t('APP_UNINSTALL_FORM_SUBMIT')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
