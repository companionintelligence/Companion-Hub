import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type RegistrationLinkCodeDialogProps = {
  /** The pairing code a `cihub://pair?code=` link brought, or null when none is waiting. */
  code: string | null;
  isPairing: boolean;
  onPair: () => void;
  onCancel: () => void;
};

/**
 * Asked before pairing with a code that came in a link.
 *
 * ⚠ A LINK IS NOT THE PERSON. Pairing gives the Portal account that made the code this Hub: it can
 * install apps and reach it from the web. Anyone can put a `cihub://pair?code=` link on a page or in a
 * message, and on a Hub that has not been paired yet the desktop app supplies the setup code itself,
 * so a link that paired on arrival handed the Hub to whoever wrote it. The code waits here for a yes.
 */
export function RegistrationLinkCodeDialog({ code, isPairing, onPair, onCancel }: RegistrationLinkCodeDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={code !== null}
      onOpenChange={(next) => {
        if (!next && !isPairing) {
          onCancel();
        }
      }}
    >
      <DialogContent size="md" data-testid="registration-link-code-dialog">
        <DialogHeader className="space-y-2 text-left">
          <DialogTitle className="flex items-start gap-2 pr-6 leading-snug">
            <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
            <span>{t('DEVICE_REGISTRATION_LINK_CODE_TITLE')}</span>
          </DialogTitle>
          <DialogDescription>{t('DEVICE_REGISTRATION_LINK_CODE_BODY')}</DialogDescription>
        </DialogHeader>
        <p className="text-center font-mono text-2xl tracking-[0.3em]" data-testid="registration-link-code">
          {code}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isPairing}>
            {t('COMMON_CANCEL')}
          </Button>
          <Button onClick={onPair} disabled={isPairing}>
            {t('DEVICE_REGISTRATION_LINK_CODE_CONFIRM')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
