import { Button } from '@/components/ui/Button';
import { OtpInput } from '@/components/ui/OtpInput';
import React from 'react';
import { useTranslation } from 'react-i18next';

type Props = {
  onSubmit: (totpCode: string) => void;
  onBack?: () => void;
  loading?: boolean;
};

export const TotpForm = (props: Props) => {
  const { onSubmit, onBack, loading } = props;
  const { t } = useTranslation();
  const [totpCode, setTotpCode] = React.useState('');

  return (
    <>
      <h2 className="text-xl font-semibold text-center mb-4">{t('COMMON_TWO_FACTOR_AUTHENTICATION')}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(totpCode);
        }}
      >
        <p className="text-sm text-muted-foreground mb-3">{t('AUTH_TOTP_INSTRUCTIONS')}</p>
        <OtpInput valueLength={6} value={totpCode} onChange={(o) => setTotpCode(o)} autoFocus />
        <div className="mt-4">
          <Button disabled={totpCode.trim().length < 6} loading={loading} intent="primary" type="submit" className="w-full mb-3">
            {t('AUTH_TOTP_SUBMIT')}
          </Button>
          {onBack && (
            <Button type="button" variant="outline" className="w-full" onClick={onBack}>
              {t('COMMON_BACK')}
            </Button>
          )}
        </div>
      </form>
    </>
  );
};
