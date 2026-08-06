import { Button } from '@/components/ui/Button';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const CORE_SERVER_URL = 'https://www.ci.computer/store/p/core';

interface CoreServerBannerProps {
  onDismiss: () => void;
}

export function CoreServerBanner({ onDismiss }: CoreServerBannerProps) {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="core-server-banner"
      className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm shadow-sm md:flex-row md:items-center md:justify-between"
    >
      <span className="leading-relaxed text-foreground">
        <strong className="font-semibold text-foreground">{t('CORE_SERVER_BANNER_LOW_DISK_TITLE')}</strong>{' '}
        <span className="text-muted-foreground">{t('CORE_SERVER_BANNER_LOW_DISK_MESSAGE')}</span>
      </span>
      <div className="flex shrink-0 items-center gap-2 self-start md:self-auto">
        <Button asChild size="sm" variant="outline">
          <a href={CORE_SERVER_URL} target="_blank" rel="noopener noreferrer">
            {t('CORE_SERVER_BANNER_LEARN_MORE')}
          </a>
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('CORE_SERVER_BANNER_DISMISS')}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
