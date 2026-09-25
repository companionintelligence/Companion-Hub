import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput/PasswordInput';
import { rememberPortalAccountEmail } from '@/lib/portal-session-hint';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useNavigate } from 'react-router';
import { DEFAULT_PORTAL_URL, persistPortalUrl, readPersistedPortalUrl, signInToPortal, writePortalAuth } from '../portal-client';
import { clientLoader } from './connect-page';

export { clientLoader };

const TOUCH = 'min-h-[44px]';

/**
 * Advanced cloud-connect settings. Not the first-connect path.
 *
 * Log in on `/connect` signs into Companion in Safari and lists Hubs. Email/
 * password here is a Portal fallback; the Portal URL is which Hub that Safari
 * hop (and this form) talk to.
 */
export default function ConnectAdvancedPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [portalUrl, setPortalUrl] = useState(readPersistedPortalUrl);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSavePortal = (event: FormEvent) => {
    event.preventDefault();
    persistPortalUrl(portalUrl);
    navigate('/connect');
  };

  const handleEmailSignIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!email || !password) return;
    setBusy(true);
    try {
      persistPortalUrl(portalUrl);
      rememberPortalAccountEmail(email);
      const auth = await signInToPortal(email, password, portalUrl);
      writePortalAuth(auth);
      navigate('/connect');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('MOBILE_CONNECT_SIGNIN_FAILED'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="safe-area-inset flex min-h-dvh flex-col items-center justify-center overflow-y-auto px-6">
      <Card className="mx-auto w-full max-w-sm shrink-0">
        <CardHeader>
          <CardTitle>{t('MOBILE_CONNECT_ADVANCED')}</CardTitle>
          <CardDescription>{t('MOBILE_CONNECT_ADVANCED_DESC')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <form onSubmit={handleSavePortal} className="flex flex-col gap-3">
            <Input
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

          <form onSubmit={(event) => void handleEmailSignIn(event)} className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">{t('MOBILE_CONNECT_EMAIL_HINT')}</p>
            <Input
              type="email"
              className={TOUCH}
              style={{ minHeight: 44 }}
              aria-label={t('MOBILE_CONNECT_EMAIL')}
              placeholder="you@example.com"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <PasswordInput
              className={TOUCH}
              aria-label={t('MOBILE_CONNECT_PASSWORD')}
              placeholder={t('MOBILE_CONNECT_PASSWORD')}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Button type="submit" className={TOUCH} loading={busy} disabled={busy || !email || !password}>
              {t('MOBILE_CONNECT_EMAIL_BUTTON')}
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
