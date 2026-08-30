import { disableTotpMutation, getTotpUriMutation, setupTotpMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { OtpInput } from '@/components/ui/OtpInput';
import { PasswordInput } from '@/components/ui/PasswordInput/PasswordInput';
import { QrCode } from '@/components/ui/qr-code';
import { Switch } from '@/components/ui/Switch';
import { useAppContext } from '@/context/app-context';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import type { TranslatableError } from '@/types/error.types';
import { useMutation } from '@tanstack/react-query';
import React from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

export const OtpForm = (props: { totpEnabled: boolean }) => {
  const { totpEnabled } = props;
  const { t } = useTranslation();
  const [password, setPassword] = React.useState('');
  const [key, setKey] = React.useState('');
  const [uri, setUri] = React.useState('');
  const [totpCode, setTotpCode] = React.useState('');
  const passwordFormId = React.useId();
  const totpFormId = React.useId();

  // Dialog statuses
  const setupOtpDisclosure = useDisclosure();
  const disableOtpDisclosure = useDisclosure();

  const { refreshAppContext } = useAppContext();

  const getTotpUri = useMutation({
    ...getTotpUriMutation(),
    onMutate: () => {
      setupOtpDisclosure.close();
    },
    onError: (e: TranslatableError) => {
      setPassword('');
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: (data) => {
      setPassword('');
      if (!data) return;
      setKey(data.key);
      setUri(data.uri);
    },
  });

  const setupTotp = useMutation({
    ...setupTotpMutation(),
    onError: (e: TranslatableError) => {
      setTotpCode('');
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: () => {
      setTotpCode('');
      setKey('');
      setUri('');
      toast.success(t('SETTINGS_SECURITY_2FA_ENABLE_SUCCESS'));
      refreshAppContext();
    },
  });

  const disableTotp = useMutation({
    ...disableTotpMutation(),
    onMutate: () => {
      disableOtpDisclosure.close();
    },
    onError: (e: TranslatableError) => {
      setPassword('');
      toast.error(t(e.message, e.intlParams));
    },
    onSuccess: () => {
      setPassword('');
      toast.success(t('SETTINGS_SECURITY_2FA_DISABLE_SUCCESS'));
      refreshAppContext();
    },
  });

  const renderSetupQr = () => {
    if (!uri || totpEnabled) return null;

    return (
      <div className="mt-4">
        {/*
          Both the QR and the base32 key encode the same second factor, so both sit
          behind `reveal`. They used to render unconditionally: a screenshot or a
          screen share of this panel handed over a permanent second factor, and
          neither re-encodes away like a copied string does.

          `fallback` is the manual-entry key rather than the otpauth URI — the URI
          is only useful to a camera, while the key is what someone types into an
          authenticator when the camera will not focus.
        */}
        <div className="mb-4">
          <QrCode
            value={uri}
            fallback={key}
            reveal
            caption={
              <>
                <span className="block">{t('SETTINGS_SECURITY_SCAN_QR_CODE')}</span>
                <span className="block">{t('SETTINGS_SECURITY_ENTER_KEY_MANUALLY')}</span>
              </>
            }
          />
        </div>
        <div className="mb-4">
          <p className="text-muted-foreground">{t('SETTINGS_SECURITY_ENTER_2FA_CODE')}</p>
          <OtpInput value={totpCode} valueLength={6} onChange={(e) => setTotpCode(e)} />
          <Button disabled={totpCode.trim().length < 6} onClick={() => setupTotp.mutate({ body: { code: totpCode } })} className="mt-3">
            {t('SETTINGS_SECURITY_ENABLE_2FA')}
          </Button>
        </div>
      </div>
    );
  };

  const handleTotp = (enabled: boolean) => {
    // Both dialogs submit from this one piece of state, so a password left over from an
    // earlier prompt would carry into the next one.
    setPassword('');

    if (enabled) {
      setupOtpDisclosure.open();
    } else {
      disableOtpDisclosure.open();
    }
  };

  return (
    <>
      {!key && <Switch onCheckedChange={handleTotp} checked={totpEnabled} label={t('SETTINGS_SECURITY_ENABLE_2FA')} />}
      {getTotpUri.isPending && (
        <div className="w-1/2 h-1.5 rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-primary rounded-full animate-pulse" />
        </div>
      )}
      {renderSetupQr()}
      <Dialog open={setupOtpDisclosure.isOpen} onOpenChange={(o: boolean) => setupOtpDisclosure.toggle(o)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('SETTINGS_SECURITY_PASSWORD_NEEDED')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="flex flex-col">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                getTotpUri.mutate({ body: { password } });
              }}
              id={passwordFormId}
            >
              <p className="text-muted-foreground">{t('SETTINGS_SECURITY_PASSWORD_NEEDED_HINT')}</p>
              <PasswordInput
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('SETTINGS_SECURITY_PASSWORD_NEEDED')}
              />
            </form>
          </DialogDescription>
          <DialogFooter>
            <Button loading={getTotpUri.isPending} type="submit" form={passwordFormId}>
              {t('SETTINGS_SECURITY_ENABLE_2FA')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={disableOtpDisclosure.isOpen} onOpenChange={(o: boolean) => disableOtpDisclosure.toggle(o)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('SETTINGS_SECURITY_PASSWORD_NEEDED')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="flex flex-col">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                disableTotp.mutate({ body: { password } });
              }}
              id={totpFormId}
            >
              <p className="text-muted-foreground">{t('SETTINGS_SECURITY_PASSWORD_NEEDED_HINT')}</p>
              <PasswordInput
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('SETTINGS_SECURITY_PASSWORD_NEEDED')}
              />
            </form>
          </DialogDescription>
          <DialogFooter>
            <Button loading={disableTotp.isPending} type="submit" intent="danger" form={totpFormId}>
              {t('SETTINGS_SECURITY_DISABLE_2FA')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
