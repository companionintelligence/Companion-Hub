import { cn } from '@/lib/utils';
import { CheckCircle2, Download, Loader2, PowerOff, Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMemoryConnection } from '../../helpers/use-memory-connection';

/**
 * Compact Companion Memory status pill for the app-detail header (rendered under
 * the FREE price badge). Mirrors the access-points status badge styling:
 * emerald when connected, neutral otherwise. Renders nothing unless the app is a
 * memory consumer (`applicable`). Because a ci-memory row exists from the moment
 * an install BEGINS — long before it is reachable — the pill distinguishes "not
 * installed" from "installed but starting/offline" so it never implies memory is
 * ready to connect when it isn't. Memory is an optional enhancement, never a
 * prerequisite for running the app, so the copy stays factual rather than
 * instructing. The Connect/Disconnect action lives in the header action row (see
 * AppActions); this is status only.
 */
export function MemoryStatusBadge({ appUrn }: { appUrn: string }) {
  const { t } = useTranslation();
  const { applicable, connected, memoryInstalled, providerStatus } = useMemoryConnection(appUrn);

  if (!applicable) {
    return null;
  }

  const pill = 'inline-flex shrink-0 items-center rounded-full border px-2 py-1 text-[11px] font-medium';
  const mutedPill = 'border-border/70 bg-muted/30 text-muted-foreground';

  // A live connection outranks a merely-down provider: the app holds a valid key,
  // so a momentarily starting/offline ci-memory shouldn't downgrade it to "not
  // connected". But require the provider to still exist — if ci-memory was
  // uninstalled (absent) the connection is dead, so fall through to "not installed"
  // rather than showing a green "connected" pill for a provider that is gone.
  if (connected && memoryInstalled) {
    return (
      <span className={cn(pill, 'border-success/30 bg-success/10 text-success')}>
        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
        {t('MEMORY_CONNECT_BADGE_CONNECTED')}
      </span>
    );
  }

  if (!memoryInstalled) {
    return (
      <span className={cn(pill, mutedPill)} title={t('MEMORY_CONNECT_NOT_INSTALLED')}>
        <Download className="mr-1 h-3.5 w-3.5" />
        {t('MEMORY_CONNECT_BADGE_NOT_INSTALLED')}
      </span>
    );
  }

  // Installed but not running: say why, so "Connect" being inert makes sense.
  if (providerStatus === 'starting') {
    return (
      <span className={cn(pill, mutedPill)} title={t('MEMORY_CONNECT_STARTING_DESC')}>
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        {t('MEMORY_CONNECT_BADGE_STARTING')}
      </span>
    );
  }

  if (providerStatus === 'offline') {
    return (
      <span className={cn(pill, mutedPill)} title={t('MEMORY_CONNECT_OFFLINE_DESC')}>
        <PowerOff className="mr-1 h-3.5 w-3.5" />
        {t('MEMORY_CONNECT_BADGE_OFFLINE')}
      </span>
    );
  }

  // Ready (running) but this app hasn't connected yet.
  return (
    <span className={cn(pill, mutedPill)}>
      <Unplug className="mr-1 h-3.5 w-3.5" />
      {t('MEMORY_CONNECT_BADGE_NOT_CONNECTED')}
    </span>
  );
}
