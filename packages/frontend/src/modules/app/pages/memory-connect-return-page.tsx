import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { AppLogo } from '@/components/app-logo/app-logo';
import { PageLoadingSpinner } from '@/components/ui/LoadingSpinner/loading-spinner';
import { useUserContext } from '@/context/user-context';
import { hubAppDeepLink, isAppUrnLike } from '@/lib/return-to-hub-app';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import './memory-connect-finishing-page.css';

/**
 * Where a Connect Memory started in the Hub's phone app ends, in the system browser it handed
 * the consent to: the finishing page forwards here once the app is running with its new key.
 * The main button is a `cihub://intent/app` link, which Android hands back to the Hub app on
 * that app's page. Staying in the browser is the secondary choice.
 */
const ReturnContent = ({ appUrn }: { appUrn: string }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // A server-confirmed name only: the URN is query-string text (see the finishing page).
  const { data } = useQuery(getAppOptions({ path: { urn: appUrn } }));
  const appName = data?.info?.name;

  return (
    <div className="mcf-page">
      <div className="mcf-card">
        <div className="mcf-brand">
          <AppLogo urn={appUrn} size={56} alt={appName} />
        </div>
        <div className="mcf-status" role="status" aria-live="polite">
          <CheckCircle2 className="mcf-check" size={34} aria-hidden="true" />
        </div>
        <h1 className="mcf-title">
          {appName ? (
            <Trans t={t} i18nKey="MEMORY_CONNECT_RETURN_TITLE" values={{ name: appName }} components={{ strong: <strong className="mcf-app" /> }} />
          ) : (
            t('MEMORY_CONNECT_RETURN_TITLE_GENERIC')
          )}
        </h1>
        <p className="mcf-desc">{t('MEMORY_CONNECT_RETURN_DESC')}</p>
        <div className="mcf-actions">
          <a className="mcf-btn mcf-btn-primary" href={hubAppDeepLink(appUrn)}>
            {t('MEMORY_CONNECT_RETURN_BUTTON')}
          </a>
          <button type="button" className="mcf-btn mcf-btn-secondary" onClick={() => navigate('/home')}>
            {t('MEMORY_CONNECT_RETURN_STAY')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default function MemoryConnectReturnPage() {
  const { isLoggedIn, isLoading } = useUserContext();
  const [params] = useSearchParams();
  const appUrn = params.get('app');

  if (isLoading) {
    return <PageLoadingSpinner />;
  }

  if (!isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  if (!isAppUrnLike(appUrn)) {
    return <Navigate to="/home" replace />;
  }

  return <ReturnContent appUrn={appUrn} />;
}
