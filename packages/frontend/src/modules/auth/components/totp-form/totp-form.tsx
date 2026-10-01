import { Button } from '@/components/ui/Button';
import { OtpInput } from '@/components/ui/OtpInput';
import React from 'react';
import { useTranslation } from 'react-i18next';

type Props = {
  onSubmit: (totpCode: string) => void;
  loading?: boolean;
};

export const TotpForm = (props: Props) => {
  const { onSubmit, loading } = props;
  const { t } = useTranslation();
  const [totpCode, setTotpCode] = React.useState('');
  const formRef = React.useRef<HTMLFormElement>(null);

  return (
    <>
      <h2 className="text-xl font-semibold text-center mb-4">{t('COMMON_TWO_FACTOR_AUTHENTICATION')}</h2>
      <form
        ref={formRef}
        onSubmit={(e) => {
          setTotpCode('');
          e.preventDefault();
          onSubmit(totpCode);
          // The code is cleared on every submit, so a wrong one leaves the person on an empty field with
          // focus on the button they just pressed. Put the cursor back on the first digit.
          formRef.current?.querySelector('input')?.focus();
        }}
      >
        <p className="text-sm text-muted-foreground mb-3">{t('AUTH_TOTP_INSTRUCTIONS')}</p>
        <OtpInput valueLength={6} value={totpCode} onChange={(o) => setTotpCode(o)} autoFocus />
        <div className="mt-4">
          <Button disabled={totpCode.trim().length < 6} loading={loading} intent="primary" type="submit" className="w-full">
            {t('AUTH_TOTP_SUBMIT')}
          </Button>
        </div>
      </form>
    </>
  );
};
