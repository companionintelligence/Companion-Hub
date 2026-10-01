import { Link, NavLink, useNavigate } from 'react-router';
import { LogOut, Home, Settings, Store, Menu, LogIn, Sun, Moon, Activity } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/Button';
import { ModeToggle } from '@/components/mode-toggle';
import { type Theme, useTheme } from '@/components/providers/theme/theme-provider';
import { useUserContext } from '@/context/user-context';
import { useMutation } from '@tanstack/react-query';
import { clearClientHubState } from '@/lib/clear-client-hub-state';
import { logoutMutation } from '@/api-client/@tanstack/react-query.gen';
import { useAppStoreState } from '@/stores/app-store';
import { useCallback, useMemo, useState } from 'react';
import { useAppContext } from '@/context/app-context';

type HeaderProps = {
  isLoggedIn?: boolean;
  allowAutoThemes?: boolean;
};

export const Header = (props: HeaderProps) => {
  const userContext = useUserContext();
  const { userSettings } = useAppContext();
  const { setTheme } = useTheme();
  const { resetBrowseToFeatured } = useAppStoreState();
  // Prefer context for authentication state
  const isLoggedIn = props.isLoggedIn ?? userContext.isLoggedIn;

  const navigate = useNavigate();
  const { t } = useTranslation();

  const logout = useMutation({
    ...logoutMutation(),
    onSuccess: () => {
      clearClientHubState();
      window.location.reload();
    },
  });

  const handleLogout = () => {
    logout.mutate({});
  };

  const openStoreWithFeaturedDefaults = useCallback(() => {
    resetBrowseToFeatured();
    navigate('/store?category=featured');
  }, [resetBrowseToFeatured, navigate]);

  const deviceName = useMemo(() => {
    const source = userSettings?.ciHubDeviceSlug?.trim();
    if (!source) return 'CI HUB';
    return source.replace(/[-_]+/g, ' ').toUpperCase();
  }, [userSettings?.ciHubDeviceSlug]);

  const navButtonBase = 'cursor-pointer text-foreground/80 hover:bg-accent hover:text-accent-foreground';
  const navButtonActive = 'bg-accent text-accent-foreground shadow-sm';

  // Common NavLink classes logic
  const getNavLinkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(buttonVariants({ variant: 'ghost', size: 'sm' }), navButtonBase, isActive ? clsx(navButtonActive, 'btn-active') : '');

  return (
    <header
      data-testid="app-header"
      className="fixed left-0 top-0 z-50 flex w-full items-center gap-2 border-b bg-background/90 px-4 shadow-sm backdrop-blur-md"
      style={{
        top: 'var(--titlebar-height, 0px)',
        paddingTop: 'var(--safe-area-top, 0px)',
        height: 'var(--header-offset)',
      }}
    >
      {/* Logo (Left) */}
      <div className="flex items-center justify-start">
        <Link to="/home" className="flex items-center gap-2" aria-label={t('COMMON_HOME')}>
          <img src="/logo.svg" alt="CI Logo Icon" className="h-8 w-8 object-contain" />
          <span className="max-w-48 truncate text-sm font-semibold tracking-wide text-chart-3 dark:text-aqua-light">{deviceName}</span>
        </Link>
      </div>

      {/* Navigation (Center) — aligned with CI Portal (absolute center, lg+ only) */}
      {isLoggedIn && (
        <nav className="absolute left-1/2 -translate-x-1/2 hidden lg:flex items-center justify-center gap-2">
          <NavLink to="/home" className={getNavLinkClass}>
            <Home className="mr-2 size-4" />
            {t('COMMON_HOME')}
          </NavLink>
          <NavLink to="/store" className={getNavLinkClass} onClick={openStoreWithFeaturedDefaults}>
            <Store className="mr-2 size-4" />
            {t('COMMON_APP_STORE')}
          </NavLink>
          <NavLink to="/resource-monitor" className={getNavLinkClass}>
            <Activity className="mr-2 size-4" />
            {t('RESOURCE_MONITOR_NAV')}
          </NavLink>
        </nav>
      )}

      {/* User Actions (Right) - Desktop */}
      <div className="hidden lg:flex items-center justify-end gap-2 ml-auto">
        <ModeToggle />

        {!isLoggedIn && (
          <Button variant="ghost" size="sm" onClick={() => navigate('/login')}>
            {t('login', 'Login')}
            <LogIn className="ml-2 size-4" />
          </Button>
        )}

        {isLoggedIn && (
          <>
            {/* Settings Link */}
            <NavLink
              to="/settings"
              title={t('COMMON_SETTINGS', 'Settings')}
              className={({ isActive }) =>
                clsx(buttonVariants({ variant: 'ghost', size: 'icon' }), navButtonBase, isActive ? clsx(navButtonActive, 'btn-active') : '')
              }
            >
              <Settings className="size-4" />
              <span className="sr-only">{t('COMMON_SETTINGS', 'Settings')}</span>
            </NavLink>

            <Button
              variant="ghost"
              size="icon"
              title={t('HEADER_LOGOUT', 'Logout')}
              onClick={handleLogout}
              className="text-foreground/80 hover:bg-accent hover:text-accent-foreground"
            >
              <LogOut className="size-4" />
              <span className="sr-only">{t('HEADER_LOGOUT', 'Logout')}</span>
            </Button>
          </>
        )}
      </div>

      <MobileAppMenu
        isLoggedIn={isLoggedIn}
        onLogout={handleLogout}
        onOpenStore={openStoreWithFeaturedDefaults}
        onLogin={() => navigate('/login')}
        setTheme={setTheme}
      />
    </header>
  );
};

const menuItemClass = 'flex min-h-[44px] w-full items-center rounded-sm px-2 text-sm text-foreground';

function MobileAppMenu({
  isLoggedIn,
  onLogout,
  onOpenStore,
  onLogin,
  setTheme,
}: {
  isLoggedIn: boolean;
  onLogout: () => void;
  onOpenStore: () => void;
  onLogin: () => void;
  setTheme: (theme: Theme) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative ml-auto flex justify-end lg:hidden">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="mobile-app-menu-btn"
        className="text-foreground"
        onClick={() => setOpen((current) => !current)}
      >
        <Menu className="size-5" />
        <span className="sr-only">{t('HEADER_OPEN_MENU')}</span>
      </Button>
      {open ? (
        <>
          <button
            type="button"
            aria-label={t('COMMON_CLOSE')}
            data-testid="mobile-app-menu-scrim"
            className="fixed inset-x-0 bottom-0 z-40 bg-black/25"
            style={{ top: 'var(--header-offset)' }}
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            data-testid="mobile-app-menu"
            className="absolute right-0 top-full z-50 mt-2 w-56 origin-top-right animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 rounded-md border bg-popover p-1 text-popover-foreground shadow-md duration-200"
          >
            {isLoggedIn ? (
              <>
                <Link role="menuitem" to="/home" className={menuItemClass} onClick={() => setOpen(false)}>
                  <Home className="mr-2 size-4" />
                  {t('COMMON_HOME')}
                </Link>
                <Link
                  role="menuitem"
                  to="/store"
                  className={menuItemClass}
                  onClick={() => {
                    setOpen(false);
                    onOpenStore();
                  }}
                >
                  <Store className="mr-2 size-4" />
                  {t('COMMON_APP_STORE')}
                </Link>
                <Link role="menuitem" to="/resource-monitor" className={menuItemClass} onClick={() => setOpen(false)}>
                  <Activity className="mr-2 size-4" />
                  {t('RESOURCE_MONITOR_NAV')}
                </Link>
                <Link role="menuitem" to="/settings" className={menuItemClass} onClick={() => setOpen(false)}>
                  <Settings className="mr-2 size-4" />
                  {t('COMMON_SETTINGS', 'Settings')}
                </Link>
                <div className="my-1 h-px bg-muted" />
                <p className="px-2 py-1 text-xs text-muted-foreground">{t('HEADER_THEME')}</p>
                <button type="button" role="menuitem" className={menuItemClass} onClick={() => setTheme('light')}>
                  <Sun className="mr-2 size-4" />
                  {t('THEME_LIGHT')}
                </button>
                <button type="button" role="menuitem" className={menuItemClass} onClick={() => setTheme('dark')}>
                  <Moon className="mr-2 size-4" />
                  {t('THEME_DARK')}
                </button>
                <button type="button" role="menuitem" className={menuItemClass} onClick={() => setTheme('system')}>
                  {t('COMMON_SYSTEM')}
                </button>
                <div className="my-1 h-px bg-muted" />
                <button type="button" role="menuitem" className={`${menuItemClass} text-red-600`} onClick={onLogout}>
                  <LogOut className="mr-2 size-4" />
                  {t('HEADER_LOGOUT', 'Logout')}
                </button>
              </>
            ) : (
              <button
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  setOpen(false);
                  onLogin();
                }}
              >
                <LogIn className="mr-2 size-4" />
                {t('login', 'Login')}
              </button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
