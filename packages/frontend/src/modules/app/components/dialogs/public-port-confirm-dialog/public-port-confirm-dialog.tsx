import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  isOpen: boolean;
  /** The port about to go on Public web. */
  port: number | null;
  onConfirm: () => void;
  /** Closes the dialog and saves nothing. The form stays as it was. */
  onCancel: () => void;
}

/**
 * Asked before an exposed port goes on Public web. The Hub keeps such a port open with no sign-in in
 * front, so webhooks and APIs behind it work, and this is where the person agrees to that.
 *
 * Cancel comes first, so it is what the dialog focuses when it opens: Enter alone saves nothing.
 */
export const PublicPortConfirmDialog = ({ isOpen, port, onConfirm, onCancel }: Props) => {
  const { t } = useTranslation();
  // The last port asked about. The parent clears `port` as it closes the dialog, and the title would
  // read "Open port  to anyone?" for the length of the fade-out.
  const [shownPort, setShownPort] = useState(port);
  if (port !== null && port !== shownPort) {
    setShownPort(port);
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent type="warning" size="sm" data-testid="public-port-confirm">
        <DialogHeader>
          <DialogTitle>{t('PORT_EXPOSE_PUBLIC_CONFIRM_TITLE', { port: shownPort ?? '' })}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="space-y-2">
          <p>{t('PORT_EXPOSE_PUBLIC_CONFIRM_DESCRIPTION')}</p>
          <p>{t('PORT_EXPOSE_PUBLIC_CONFIRM_PRIVATE', { local: t('APP_INSTALL_FORM_EXPOSURE_LOCAL'), vpn: t('COMMON_PRIVATE_VPN') })}</p>
        </DialogDescription>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('COMMON_CANCEL')}
          </Button>
          <Button type="button" intent="warning" onClick={onConfirm} data-testid="public-port-confirm-submit">
            {t('PORT_EXPOSE_PUBLIC_CONFIRM_SUBMIT')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
