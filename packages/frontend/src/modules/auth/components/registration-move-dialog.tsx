import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { ArrowRightLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type RegistrationMoveDialogProps = {
  open: boolean;
  /** The organization the code belongs to, as the Portal named it. Older Portals send none. */
  organizationName: string | null;
  isPairing: boolean;
  onMove: () => void;
  onCancel: () => void;
};

/**
 * Asked when the Portal answers `DEVICE_MOVE_CONFIRMATION_REQUIRED`: this Hub is
 * registered to another organization, and pairing with this code moves it here.
 *
 * Nothing has changed yet. The organization it leaves loses the Hub along with
 * its apps and web addresses there, and the person at the Hub may not know the
 * Hub was anyone else's, so the move waits for a yes.
 */
export function RegistrationMoveDialog({ open, organizationName, isPairing, onMove, onCancel }: RegistrationMoveDialogProps) {
  const { t } = useTranslation();
  const organization = organizationName ?? t('DEVICE_REGISTRATION_MOVE_THIS_ORGANIZATION');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isPairing) {
          onCancel();
        }
      }}
    >
      <DialogContent size="md" data-testid="registration-move-dialog">
        <DialogHeader className="space-y-2 text-left">
          <div className="flex items-center gap-2 text-primary">
            <ArrowRightLeft className="h-5 w-5 shrink-0" aria-hidden />
          </div>
          <DialogTitle>{t('DEVICE_REGISTRATION_MOVE_TITLE', { organization })}</DialogTitle>
          <DialogDescription>{t('DEVICE_REGISTRATION_MOVE_BODY', { organization })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isPairing}>
            {t('COMMON_CANCEL')}
          </Button>
          <Button onClick={onMove} disabled={isPairing}>
            {t('DEVICE_REGISTRATION_MOVE_CONFIRM')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
