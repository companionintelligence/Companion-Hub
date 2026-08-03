import { Link, NavLink, useNavigate } from 'react-router';
import { LogOut, Home, Settings, Store, Menu, LogIn, Sun, Moon, Activity } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { ModeToggle } from '@/components/mode-toggle';
import { useTheme } from '@/components/providers/theme/theme-provider';
import { useUserContext } from '@/context/user-context';
import { useMutation } from '@tanstack/react-query';
import { clearClientHubState } from '@/lib/clear-client-hub-state';
import { logoutMutation } from '@/api-client/@tanstack/react-query.gen';
import { useAppStoreState } from '@/stores/app-store';
import { useCallback, useMemo } from 'react';
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
      clearClientHubState({ keepPortalEmail: true });
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

  const navButtonBase =
    'cursor-pointer text-foreground/80 hover:bg-primary/12 hover:text-primary dark:text-foreground dark:hover:bg-accent dark:hover:text-accent-foreground';
  const navButtonActive = 'bg-primary/12 text-primary shadow-sm dark:bg-accent dark:text-accent-foreground dark:shadow-none';

  // Common NavLink classes logic
  const getNavLinkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(buttonVariants({ variant: 'ghost', size: 'sm' }), navButtonBase, isActive ? clsx(navButtonActive, 'btn-active') : '');

  return (
    <header
      className="fixed left-0 top-0 z-50 flex h-14 w-full items-center gap-2 border-b bg-background/90 px-4 shadow-sm backdrop-blur-md"
      style={{ top: 'var(--titlebar-height, 0px)' }}
    >
      {/* Logo (Left) */}
      <div className="flex items-center justify-start">
        <Link to="/home" className="flex items-center gap-2" aria-label={t('COMMON_HOME')}>
          <img src="/logo.svg" alt="CI Logo Icon" className="h-8 w-8 object-contain" />
          <span className="max-w-48 truncate text-sm font-semibold tracking-wide text-[#066C80] dark:text-[#72DDD4]">{deviceName}</span>
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
              className="text-foreground/80 hover:bg-primary/12 hover:text-primary dark:text-foreground dark:hover:bg-accent dark:hover:text-accent-foreground"
            >
              <LogOut className="size-4" />
              <span className="sr-only">{t('HEADER_LOGOUT', 'Logout')}</span>
            </Button>
          </>
        )}
      </div>

      {/* Mobile Menu (Right) */}
      <div className="flex lg:hidden justify-end ml-auto">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <Menu className="size-5" />
              <span className="sr-only">{t('HEADER_OPEN_MENU')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {isLoggedIn ? (
              <>
                <DropdownMenuItem asChild>
                  <Link to="/home" className="w-full cursor-pointer flex items-center">
                    <Home className="mr-2 size-4" />
                    {t('COMMON_HOME')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/store" className="w-full cursor-pointer flex items-center" onClick={openStoreWithFeaturedDefaults}>
                    <Store className="mr-2 size-4" />
                    {t('COMMON_APP_STORE')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/resource-monitor" className="w-full cursor-pointer flex items-center">
                    <Activity className="mr-2 size-4" />
                    {t('RESOURCE_MONITOR_NAV')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings" className="w-full cursor-pointer flex items-center">
                    <Settings className="mr-2 size-4" />
                    {t('COMMON_SETTINGS', 'Settings')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <div className="relative mr-2 size-4">
                      <Sun className="absolute size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                      <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                    </div>
                    <span>{t('HEADER_THEME')}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => setTheme('light')}>{t('THEME_LIGHT')}</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTheme('dark')}>{t('THEME_DARK')}</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTheme('system')}>{t('COMMON_SYSTEM')}</DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="cursor-pointer flex items-center text-red-600 focus:text-red-600">
                  <LogOut className="mr-2 size-4" />
                  {t('HEADER_LOGOUT', 'Logout')}
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onClick={() => navigate('/login')} className="cursor-pointer flex items-center">
                <LogIn className="mr-2 size-4" />
                {t('login', 'Login')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
};
