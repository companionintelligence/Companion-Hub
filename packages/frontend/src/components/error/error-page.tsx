import { formatApiError } from '@/lib/format-api-error';
import { RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';

type ErrorPageProps = {
  onReset: () => void;
  error: Error;
};

export const ErrorPage = ({ error, onReset }: ErrorPageProps) => {
  const { t } = useTranslation();
  const userMessage = formatApiError(error, t);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md text-center">
        <p className="text-xl font-semibold text-foreground mb-2">{t('ERROR_PAGE_TITLE')}</p>
        <p className="text-sm text-muted-foreground mb-4">{userMessage}</p>
        <div className="mb-4">
          <Button intent="primary" onClick={onReset}>
            <RotateCw className="mr-2 h-4 w-4" />
            {t('COMMON_RETRY')}
          </Button>
        </div>
        {import.meta.env.DEV ? (
          <pre className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 text-left overflow-auto" style={{ whiteSpace: 'normal' }}>
            {error.message}
            <br />
            {t('ERROR_PAGE_LOCATION')}: {location.pathname}
          </pre>
        ) : null}
      </div>
    </div>
  );
};
