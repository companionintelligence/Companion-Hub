import { useUIStore } from '@/stores/ui-store';
import { IconArrowLeft, IconCertificate, IconLogin, IconSettings } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import { Tooltip } from 'react-tooltip';

type BaseHeaderProps = {
  isLoggedIn: boolean;
  allowAutoThemes: boolean;
  showNav?: boolean;
  showCertificateButton?: boolean;
  onLogout?: () => void;
  onLogin?: () => void;
  navbarContent?: ReactNode;
};

export const BaseHeader = (props: BaseHeaderProps) => {
  const { isLoggedIn, showNav = false, showCertificateButton = false, onLogin, navbarContent } = props;
  const location = useLocation();
  const { t } = useTranslation();

  const downloadCertificate = () => {
    window.open('/api/system/certificate');
  };

  const handleLoginClick = () => {
    if (onLogin) {
      onLogin();
    }
  };

  const isDashboard = location.pathname === '/dashboard';

  return (
    <header className="navbar navbar-expand-md navbar-overlap d-print-none">
      <div className="container-xl">
        {showNav && (
          <button className="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbar-menu">
            <span className="navbar-toggler-icon" />
          </button>
        )}
        {isDashboard ? (
          <div />
        ) : (
          <Link to="/dashboard" className="nav-link px-0 cursor-pointer me-3" aria-label="Back">
            <IconArrowLeft size={20} />
          </Link>
        )}
        <div className="navbar-nav flex-row order-md-last">
          <div style={{ zIndex: 1 }} className="d-flex gap-2">
            {showCertificateButton && (
              <>
                <Tooltip className="tooltip" anchorSelect=".downloadCert">
                  {t('GUEST_DASHBOARD_DOWNLOAD_CERTIFICATE_TOOLTIP')}
                </Tooltip>
                <button
                  type="button"
                  onClick={downloadCertificate}
                  className="downloadCert nav-link px-0 cursor-pointer"
                  data-testid="download-certificate-button"
                >
                  <IconCertificate size={20} />
                </button>
              </>
            )}

            {isLoggedIn ? (
              <>
                <Tooltip className="tooltip" anchorSelect=".settings">
                  {t('HEADER_SETTINGS')}
                </Tooltip>
                <Link to="/settings" className="settings nav-link px-0 cursor-pointer" data-testid="settings-button">
                  <IconSettings size={20} />
                </Link>
              </>
            ) : (
              <>
                <Tooltip className="tooltip" anchorSelect=".logIn">
                  {t('HEADER_LOGIN')}
                </Tooltip>
                <button
                  type="button"
                  onClick={handleLoginClick}
                  tabIndex={0}
                  className="logIn nav-link px-0 cursor-pointer"
                  data-testid="login-button"
                >
                  <IconLogin size={20} />
                </button>
              </>
            )}
          </div>
        </div>
        {navbarContent}
      </div>
    </header>
  );
};
