import { cn } from '@/lib/utils';
import { CheckCircle2, Download, Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMemoryConnection } from '../../helpers/use-memory-connection';

/**
 * Compact Companion Memory status pill for the app-detail header (rendered under
 * the FREE price badge). Mirrors the access-points status badge styling:
 * emerald when connected, neutral otherwise. Renders nothing unless the app is a
 * memory consumer (`applicable`). When Companion Memory isn't installed there's
 * nothing to connect to (and the Connect button is hidden), so instead of a
 * "not connected" status the user couldn't act on, it reports the install state.
 * Memory is an optional enhancement, never a prerequisite for running the app,
 * so the copy stays factual rather than instructing. The Connect/Disconnect
 * action lives in the header action row (see AppActions); this is status only.
 */
export function MemoryStatusBadge({ appUrn }: { appUrn: string }) {
  const { t } = useTranslation();
  const { applicable, connected, memoryInstalled } = useMemoryConnection(appUrn);

  if (!applicable) {
    return null;
  }

  const mutedPill = 'border-border/70 bg-muted/30 text-muted-foreground';

  if (!memoryInstalled) {
    return (
      <span
        className={cn('inline-flex shrink-0 items-center rounded-full border px-2 py-1 text-[11px] font-medium', mutedPill)}
        title={t('MEMORY_CONNECT_NOT_INSTALLED')}
      >
        <Download className="mr-1 h-3.5 w-3.5" />
        {t('MEMORY_CONNECT_BADGE_NOT_INSTALLED')}
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-2 py-1 text-[11px] font-medium',
        connected ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : mutedPill,
      )}
    >
      {connected ? <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> : <Unplug className="mr-1 h-3.5 w-3.5" />}
      {connected ? t('MEMORY_CONNECT_BADGE_CONNECTED') : t('MEMORY_CONNECT_BADGE_NOT_CONNECTED')}
    </span>
  );
}
