import { cn } from '@/lib/utils';
import { CheckCircle2, Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMemoryConnection } from '../../helpers/use-memory-connection';

/**
 * Compact Companion Memory status pill for the app-detail header (rendered under
 * the FREE price badge). Mirrors the access-points status badge styling:
 * emerald when connected, neutral otherwise. Renders nothing unless the app is a
 * memory consumer (`applicable`), so non-memory apps are unaffected. The
 * Connect/Disconnect action lives in the header action row (see AppActions);
 * this is status only.
 */
export function MemoryStatusBadge({ appUrn }: { appUrn: string }) {
  const { t } = useTranslation();
  const { applicable, connected } = useMemoryConnection(appUrn);

  if (!applicable) {
    return null;
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-1 text-[11px] font-medium',
        connected
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-border/70 bg-muted/30 text-muted-foreground',
      )}
    >
      {connected ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : <Unplug className="mr-1 h-3.5 w-3.5" />}
      {connected ? t('MEMORY_CONNECT_BADGE_CONNECTED') : t('MEMORY_CONNECT_BADGE_NOT_CONNECTED')}
    </span>
  );
}
