import { Button } from '@/components/ui/Button';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The Settings panel's way in to the guide. Shown by the panel while nothing is paired, where the
 * only other content is a list of manual controls and an empty "No Hubs paired yet".
 */
export function PoolSetupCallout({ onOpen, disabled = false }: { onOpen: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      data-testid="pool-setup-callout"
      className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 space-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {t('HUB_POOL_SETUP_CALLOUT_TITLE')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_CALLOUT_BODY')}</p>
      </div>
      <Button
        type="button"
        size="sm"
        className="shrink-0 self-start sm:self-auto"
        disabled={disabled}
        onClick={onOpen}
        data-testid="pool-setup-callout-open"
      >
        {t('HUB_POOL_SETUP_OPEN')}
      </Button>
    </section>
  );
}
