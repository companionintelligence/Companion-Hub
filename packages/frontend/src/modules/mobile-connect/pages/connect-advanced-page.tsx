import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { DEFAULT_PORTAL_URL, persistPortalUrl, readPersistedPortalUrl } from '../portal-client';
import { clientLoader } from './connect-page';

export { clientLoader };

const TOUCH = 'min-h-[44px]';

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

  const handleSavePortal = (event: FormEvent) => {
    event.preventDefault();
    persistPortalUrl(portalUrl);
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
            <Button type="submit" variant="outline" className={TOUCH}>
              {t('MOBILE_CONNECT_SAVE_PORTAL')}
            </Button>
          </form>

          <Button type="button" variant="ghost" className={`w-full ${TOUCH}`} onClick={() => navigate('/connect')}>
            {t('MOBILE_CONNECT_BACK_TO_LOGIN')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
