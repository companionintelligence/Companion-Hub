import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { relayNavigation } from '@/lib/navigation-relay';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Where an app's sign-in redirect lands (`GET /api/auth/edge-sso` sends it here): asks the Hub for a
 * one-time ticket for that app with this page's own session token, then goes to the app.
 *
 * ⚠ THE TICKET IS NOT MINTED ON THE NAVIGATION. That used to happen in the API route, authorised by
 * the `ci-hub-sid` cookie the navigation carried. The cookie goes to every port on the Hub's host,
 * so an app holding it could mint tickets for any other app. See `relayNavigation`.
 */
export default function EdgeSsoPage() {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<'cookies' | 'invalid' | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;

    const redirect = new URLSearchParams(window.location.search).get('redirect');
    if (!redirect) {
      setFailure('invalid');
      return;
    }

    void relayNavigation('/api/auth/edge-sso', { redirect }).then((outcome) => {
      if (outcome.kind === 'refused') {
        // 409: signing in to an app needs that app's cookie, and this browser keeps refusing it.
        setFailure(outcome.status === 409 ? 'cookies' : 'invalid');
      }
    });
  }, []);

  if (failure === 'cookies') {
    return (
      <div style={{ fontFamily: 'sans-serif', maxWidth: '32rem', margin: '4rem auto' }}>
        <h1>{t('EDGE_SSO_COOKIES_REQUIRED_TITLE')}</h1>
        <p>{t('EDGE_SSO_COOKIES_REQUIRED_DESC')}</p>
      </div>
    );
  }
  if (failure === 'invalid') {
    return (
      <div style={{ fontFamily: 'sans-serif', maxWidth: '32rem', margin: '4rem auto' }}>
        <p>{t('EDGE_SSO_FAILED')}</p>
      </div>
    );
  }
  return (
    <div role="status" aria-label={t('EDGE_SSO_SIGNING_IN')}>
      <PageLoadingSpinner />
    </div>
  );
}
