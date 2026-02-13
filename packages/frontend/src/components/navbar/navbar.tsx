import { useUIStore } from '@/stores/ui-store';
import { LayoutGrid, ShoppingBag, Home, Settings } from 'lucide-react';
import clsx from 'clsx';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import './navbar.css';

interface IProps {
  isUpdateAvailable?: boolean;
}

export const NavBar: React.FC<IProps> = ({ isUpdateAvailable: _isUpdateAvailable }) => {
  const { t } = useTranslation();
  const activeRoute = useUIStore((state) => state.activeRoute);

  const renderItem = (title: string, name: string, IconComponent: typeof LayoutGrid) => {
    const isActive = activeRoute?.split('/')[0] === name;
    const itemClass = clsx('nav-item', { active: isActive, 'border-primary': isActive });

    return (
      <li aria-label={title} data-testid={`nav-item-${name}`} className={itemClass}>
        <Link to={`/${name}`} className="nav-link">
          <span className={`nav-link-icon d-md-none d-lg-inline-block navbar-icon-${name}`}>
            <IconComponent size={24} />
          </span>
          <span className="nav-link-title">{title}</span>
        </Link>
      </li>
    );
  };

  return (
    <div id="navbar-menu" className="collapse navbar-collapse">
      <div className="d-flex flex-column flex-md-row flex-fill align-items-stretch align-items-md-center">
        <ul className="navbar-nav gap-1">
          {renderItem(t('HEADER_DASHBOARD'), 'dashboard', Home)}
          {renderItem(t('HEADER_APPS'), 'apps', LayoutGrid)}
          {renderItem(t('HEADER_APP_STORE'), 'app-store', ShoppingBag)}
          {renderItem(t('HEADER_SETTINGS'), 'settings', Settings)}
        </ul>
      </div>
    </div>
  );
};
