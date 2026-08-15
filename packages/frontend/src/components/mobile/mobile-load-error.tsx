import { clearHubConnection } from '@/lib/mobile-connection';
import { useTranslation } from 'react-i18next';

interface MobileLoadErrorProps {
  message?: string;
  onRetry?: () => void;
}

/** Replaces an infinite spinner on the phone when a remote Hub call never settles. */
export function MobileLoadError({ message, onRetry }: MobileLoadErrorProps) {
  const { t } = useTranslation();

  return (
    <div className="safe-area-inset flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center" role="alert">
      <p className="text-base font-medium">{message || t('MOBILE_LOAD_FAILED')}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{t('MOBILE_LOAD_FAILED_HINT')}</p>
      <div className="flex w-full max-w-sm flex-col gap-3">
        {onRetry ? (
          <button
            type="button"
            data-testid="mobile-load-retry"
            className="min-h-[44px] rounded-md bg-primary px-6 text-base font-semibold text-primary-foreground"
            onClick={onRetry}
          >
            {t('COMMON_RETRY')}
          </button>
        ) : null}
        <button
          type="button"
          data-testid="mobile-load-switch-hub"
          className="min-h-[44px] text-sm text-muted-foreground underline"
          onClick={() => {
            void clearHubConnection().finally(() => window.location.assign('/connect'));
          }}
        >
          {t('MOBILE_CONNECT_SWITCH_HUB')}
        </button>
      </div>
    </div>
  );
}
