import { Link, NavLink, useNavigate } from 'react-router';
import { LogOut, Home, Settings, Store, Menu, LayoutGrid, LogIn, Sun, Moon } from 'lucide-react';
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
import { logoutMutation } from '@/api-client/@tanstack/react-query.gen';

type HeaderProps = {
  isUpdateAvailable?: boolean;
  isLoggedIn?: boolean;
  allowAutoThemes?: boolean;
};

export const Header = (props: HeaderProps) => {
  const userContext = useUserContext();
  const { setTheme } = useTheme();
  // Prefer context for authentication state
  const isLoggedIn = props.isLoggedIn ?? userContext.isLoggedIn;

  const navigate = useNavigate();
  const { t } = useTranslation();

  const logout = useMutation({
    ...logoutMutation(),
    onSuccess: () => {
      window.location.reload();
    },
  });

  const handleLogout = () => {
    logout.mutate({});
  };

  // Common NavLink classes logic
  const getNavLinkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(buttonVariants({ variant: 'ghost', size: 'sm' }), isActive ? 'bg-accent text-accent-foreground btn-active' : '');

  return (
    <header className="fixed top-4 left-1/2 z-50 flex h-14 w-[95%] md:w-1/2 -translate-x-1/2 items-center justify-between gap-2 rounded-full border bg-background/80 px-4 shadow-md backdrop-blur-md">
      {/* Logo (Left) */}
      <div className="flex flex-1 items-center justify-start">
        <Link to="/dashboard" className="flex items-center">
          <img src="/2024_CI__Logo_Banner_Color_small.svg" alt="Companion Intelligence Logo" className="h-8 w-auto object-contain" />
        </Link>
      </div>

      {/* Navigation (Center) - Desktop */}
      {isLoggedIn && (
        <nav className="hidden md:flex items-center justify-center gap-2">
          <NavLink to="/dashboard" className={getNavLinkClass}>
            <Home className="mr-2 size-4" />
            {t('HEADER_DASHBOARD', 'Dashboard')}
          </NavLink>
          <NavLink to="/apps" className={getNavLinkClass}>
            <LayoutGrid className="mr-2 size-4" />
            {t('HEADER_APPS', 'Apps')}
          </NavLink>
          <NavLink to="/app-store" className={getNavLinkClass}>
            <Store className="mr-2 size-4" />
            {t('HEADER_APP_STORE', 'Store')}
          </NavLink>
        </nav>
      )}

      {/* User Actions (Right) - Desktop */}
      <div className="hidden md:flex flex-1 items-center justify-end gap-2">
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
              title={t('HEADER_SETTINGS', 'Settings')}
              className={({ isActive }) =>
                clsx(buttonVariants({ variant: 'ghost', size: 'icon' }), isActive ? 'bg-accent text-accent-foreground btn-active' : '')
              }
            >
              <Settings className="size-4" />
              <span className="sr-only">{t('HEADER_SETTINGS', 'Settings')}</span>
            </NavLink>

            <Button variant="ghost" size="icon" title={t('HEADER_LOGOUT', 'Logout')} onClick={handleLogout}>
              <LogOut className="size-4" />
              <span className="sr-only">{t('HEADER_LOGOUT', 'Logout')}</span>
            </Button>
          </>
        )}
      </div>

      {/* Mobile Menu (Right) */}
      <div className="flex md:hidden flex-1 justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <Menu className="size-5" />
              <span className="sr-only">Open menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {isLoggedIn ? (
              <>
                <DropdownMenuItem asChild>
                  <Link to="/dashboard" className="w-full cursor-pointer flex items-center">
                    <Home className="mr-2 size-4" />
                    {t('HEADER_DASHBOARD', 'Dashboard')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/apps" className="w-full cursor-pointer flex items-center">
                    <LayoutGrid className="mr-2 size-4" />
                    {t('HEADER_APPS', 'Apps')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/app-store" className="w-full cursor-pointer flex items-center">
                    <Store className="mr-2 size-4" />
                    {t('HEADER_APP_STORE', 'Store')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings" className="w-full cursor-pointer flex items-center">
                    <Settings className="mr-2 size-4" />
                    {t('HEADER_SETTINGS', 'Settings')}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <div className="relative mr-2 size-4">
                      <Sun className="absolute size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                      <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                    </div>
                    <span>Theme</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => setTheme('light')}>Light</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTheme('dark')}>Dark</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTheme('system')}>System</DropdownMenuItem>
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
