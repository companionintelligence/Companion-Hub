import { acknowledgeWelcomeMutation } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { getLogo } from '@/lib/theme/theme';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

type Props = {
  allowErrorMonitoring: boolean;
};

export const Welcome = ({ allowErrorMonitoring }: Props) => {
  const [errorMonitoring, setErrorMonitoring] = useState(allowErrorMonitoring);
  const { t } = useTranslation();

  const acknowledge = useMutation({
    ...acknowledgeWelcomeMutation(),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <img
            alt={t('APP_NAME')}
            src={getLogo(true)}
            height={80}
            width={80}
            className="mx-auto"
            style={{
              maxWidth: '100%',
              height: 'auto',
            }}
          />
        </div>
        <Card className="w-full">
          <CardContent className="p-6">
            <h2 className="text-xl font-semibold text-center mb-2">{t('WELCOME_TITLE')}</h2>
            <p className="text-sm text-muted-foreground text-center mb-6">{t('WELCOME_SUBTITLE')}</p>
            <div className="flex flex-col items-center gap-4">
              <Switch checked={errorMonitoring} onCheckedChange={setErrorMonitoring} label={t('WELCOME_ENABLE_ERROR_REPORTING')} />
              <Button
                intent="primary"
                className="w-full"
                onClick={() => acknowledge.mutate({ body: { allowErrorMonitoring: errorMonitoring } })}
                loading={acknowledge.isPending}
                disabled={acknowledge.isPending}
              >
                {t('WELCOME_SAVE_AND_ENTER')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
