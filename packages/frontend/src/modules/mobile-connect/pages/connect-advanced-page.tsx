import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ArrowLeft } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { clearPortalAuth, DEFAULT_PORTAL_URL, persistPortalUrl, readPersistedPortalUrl, readStoredPortalAuth } from '../portal-client';
import { clientLoader } from './connect-page';

export { clientLoader };

const TOUCH = 'min-h-[44px]';
/** Both buttons share one width, centred, instead of stretching across the card. */
const ACTION = `w-52 self-center ${TOUCH}`;

/**
 * Advanced cloud-connect settings. Not the first-connect path.
 *
 * Log in on `/connect` signs into Companion in the browser and lists Hubs. The
 * Companion URL here is which Portal that browser hop talks to.
 */
export default function ConnectAdvancedPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [portalUrl, setPortalUrl] = useState(readPersistedPortalUrl);

  // With a Portal sign-in stored, `/connect` reopens on the Hub picker, not on Log in.
  const [returnsToHubChoice] = useState(() => readStoredPortalAuth() !== null);

  const handleSavePortal = (event: FormEvent) => {
    event.preventDefault();
    const previous = readPersistedPortalUrl();
    // A sign-in belongs to the Companion server that issued it. Never carry
    // its tokens over to a different one.
    if (persistPortalUrl(portalUrl) !== previous) clearPortalAuth();
    navigate('/connect');
  };

  return (
    <div className="safe-area-inset flex h-dvh flex-col items-center justify-center-safe overflow-y-auto px-6">
      <Card className="mx-auto w-full max-w-sm shrink-0">
        <CardHeader>
          <CardTitle>{t('MOBILE_CONNECT_ADVANCED')}</CardTitle>
          <CardDescription>{t('MOBILE_CONNECT_ADVANCED_DESC')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <form onSubmit={handleSavePortal} className="flex flex-col gap-3">
            <Input
              id="portal-url"
              type="url"
              className={TOUCH}
              style={{ minHeight: 44 }}
              label={t('MOBILE_CONNECT_PORTAL_URL')}
              aria-label={t('MOBILE_CONNECT_PORTAL_URL')}
              placeholder={DEFAULT_PORTAL_URL}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              value={portalUrl}
              onChange={(e) => setPortalUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('MOBILE_CONNECT_PORTAL_HINT')}</p>
            <Button type="submit" variant="outline" className={ACTION}>
              {t('MOBILE_CONNECT_SAVE_PORTAL')}
            </Button>
          </form>

          <Button type="button" variant="outline" className={`gap-2 ${ACTION}`} onClick={() => navigate('/connect')}>
            <ArrowLeft aria-hidden className="size-4" />
            {t(returnsToHubChoice ? 'MOBILE_CONNECT_BACK_TO_HUB_CHOICE' : 'MOBILE_CONNECT_BACK_TO_LOGIN')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
