import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import { useTranslation } from 'react-i18next';

/** Manual app store URLs (Tipi-era) were removed; CI Hubs use the auto-configured CI Marketplace. */
export const AddAppStoreDialog = () => {
  const { t } = useTranslation();
  const addAppStoreDisclosure = useDisclosure();

  return (
    <div className="mt-3 align-self-end">
      <Button onClick={() => addAppStoreDisclosure.open()} intent="primary">
        {t('APP_STORE_ADD_BUTTON')}
      </Button>
      <Dialog open={addAppStoreDisclosure.isOpen} onOpenChange={addAppStoreDisclosure.toggle}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('APP_STORE_ADD_DIALOG_TITLE')}</DialogTitle>
            <DialogDescription>{t('APP_STORE_ADD_COMING_SOON')}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t('APP_STORE_ADD_COMING_SOON_DETAIL')}</p>
          <DialogFooter>
            <Button disabled intent="success">
              {t('APP_STORE_ADD_FORM_SUBMIT')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
