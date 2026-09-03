import { cancelOperationMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import type { AppInfo } from '@/types/app.types';
import type { TranslatableError } from '@/types/error.types';
import { CircleStop } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

interface IProps {
  info: AppInfo;
  isOpen: boolean;
  onClose: () => void;
  /** Called when the user confirms the cancel, so the parent can show a "cancelling" state. */
  onCancelStart?: () => void;
}

/**
 * Confirmation dialog for cancelling an in-progress install. Unlike uninstall, there is no
 * installed app or data to destroy yet — cancelling stops the download and removes the partial
 * install, so the copy is reassuring rather than a destructive warning. Sends the server-side
 * cancel for the app's active operation (no requestId — the backend resolves the active op).
 */
export const CancelInstallDialog = ({ info, isOpen, onClose, onCancelStart }: IProps) => {
  const { t } = useTranslation();

  // While the request is in flight the confirm button shows a loading state and is disabled, which
  // prevents duplicate cancels (the dialog can still be dismissed via its close button/overlay). The
  // dialog auto-closes once the request settles, and the optimistic "Cancelling…" state is only
  // entered when the server confirms it accepted the cancel, so a refused/failed request never
  // leaves the UI stuck.
  const cancelMutation = useMutation({
    ...cancelOperationMutation(),
    onSuccess: (data) => {
      if (data?.outcome === 'cancelling' || data?.outcome === 'cancelled_queued') {
        onCancelStart?.();
      } else {
        // refused / not_found — the install is past the point of no return or already finished.
        toast.error(t('APP_ERROR_CANNOT_CANCEL'));
      }
      onClose();
    },
    onError: (error: TranslatableError) => {
      toast.error(t(error.message, error.intlParams));
      onClose();
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent type="danger" size="sm">
        <DialogHeader>
          <DialogTitle>{t('APP_CANCEL_INSTALL_TITLE', { name: info.name })}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-center py-4">
          <CircleStop className="mb-2 text-destructive size-12 mx-auto" />
          <span className="text-muted-foreground">{t('APP_CANCEL_INSTALL_BODY')}</span>
        </DialogDescription>
        <DialogFooter>
          <Button onClick={() => cancelMutation.mutate({ path: { urn: info.urn }, body: {} })} loading={cancelMutation.isPending} intent="danger">
            {t('APP_CANCEL_INSTALL_SUBMIT')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
