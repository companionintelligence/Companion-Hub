import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLiveSession } from '@/lib/inference/live-session';

/** Says up front what a Companion OS live session can't do, before setup offers those things. */
export const LiveSessionNotice = () => {
  const { t } = useTranslation();
  const liveSession = useLiveSession();

  if (!liveSession?.live) return null;

  // An image can leave either one out, and then the block isn't there to report.
  const blocked = liveSession.ollamaBlocked
    ? liveSession.tailscaleBlocked
      ? t('ONBOARDING_LIVE_SESSION_BLOCKS_BOTH')
      : t('ONBOARDING_LIVE_SESSION_BLOCKS_OLLAMA')
    : liveSession.tailscaleBlocked
      ? t('ONBOARDING_LIVE_SESSION_BLOCKS_TAILSCALE')
      : null;

  return (
    <section className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4 text-warning" data-testid="live-session-notice">
      <Info className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="text-sm">
        <p className="font-medium">{t('ONBOARDING_LIVE_SESSION_TITLE')}</p>
        <p className="mt-1 text-xs">
          {blocked && `${blocked} `}
          {t('ONBOARDING_LIVE_SESSION_DESC')}
        </p>
      </div>
    </section>
  );
};
