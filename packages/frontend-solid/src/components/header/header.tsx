import { A, useLocation } from '@solidjs/router';
import { Show } from 'solid-js';
import { clsx } from 'clsx';
import { Home, Store, Settings, LogOut, LogIn, Menu } from 'lucide-solid';
import { Button, buttonVariants } from '@/components/ui/Button';
import { ModeToggle } from '@/components/mode-toggle';
import { useUserContext } from '@/context/user-context';
import { api } from '@/api-client';
import { createSignal } from 'solid-js';

interface HeaderProps {
  isLoggedIn?: boolean;
  isUpdateAvailable?: boolean;
}

export function Header(props: HeaderProps) {
  const { userContext } = useUserContext();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = createSignal(false);

  const isLoggedIn = () => props.isLoggedIn ?? userContext().isLoggedIn;

  const handleLogout = async () => {
    try {
      await api.logout();
    } finally {
      window.location.reload();
    }
  };

  const navLinkClass = (path: string) =>
    clsx(
      buttonVariants({ variant: 'ghost', size: 'sm' }),
      'cursor-pointer',
      location.pathname.startsWith(path) ? 'bg-accent text-accent-foreground' : '',
    );

  return (
    <header
      class="fixed left-1/2 z-50 flex h-14 w-[96%] md:w-[77%] lg:w-[70%] xl:w-[53%] -translate-x-1/2 items-center gap-2 rounded-full border bg-background/80 px-3 shadow-md backdrop-blur-md"
      style={{ top: 'calc(var(--titlebar-height, 0px) + 1rem)' }}
    >
      {/* Logo */}
      <div class="flex items-center justify-start">
        <A href="/dashboard" class="flex items-center">
          <img src="/2024_CI__Logo_Banner_Color_small.svg" alt="Companion Intelligence Logo" class="h-9 w-auto object-contain hidden dark:block" />
          <img
            src="/2024_CI__Logo_Banner_Color_small-lightmode2.svg"
            alt="Companion Intelligence Logo"
            class="h-9 w-auto object-contain block dark:hidden"
          />
        </A>
      </div>

      {/* Desktop Nav */}
      <Show when={isLoggedIn()}>
        <nav class="absolute left-1/2 -translate-x-1/2 hidden lg:flex items-center justify-center gap-2">
          <A href="/dashboard" class={navLinkClass('/dashboard')}>
            <Home class="mr-2 size-4" />
            Home
          </A>
          <A href="/app-store" class={navLinkClass('/app-store')}>
            <Store class="mr-2 size-4" />
            Store
          </A>
        </nav>
      </Show>

      {/* Desktop Right Actions */}
      <div class="hidden lg:flex items-center justify-end gap-2 ml-auto">
        <ModeToggle />

        <Show when={!isLoggedIn()}>
          <A href="/login" class={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Login
            <LogIn class="ml-2 size-4" />
          </A>
        </Show>

        <Show when={isLoggedIn()}>
          <A
            href="/settings"
            title="Settings"
            class={clsx(
              buttonVariants({ variant: 'ghost', size: 'icon' }),
              location.pathname.startsWith('/settings') ? 'bg-accent text-accent-foreground' : '',
            )}
          >
            <Settings class="size-4" />
            <span class="sr-only">Settings</span>
          </A>
          <Button variant="ghost" size="icon" title="Logout" onClick={handleLogout}>
            <LogOut class="size-4" />
            <span class="sr-only">Logout</span>
          </Button>
        </Show>
      </div>

      {/* Mobile Menu */}
      <div class="flex lg:hidden justify-end ml-auto relative">
        <Button variant="ghost" size="icon" onClick={() => setMobileOpen(!mobileOpen())}>
          <Menu class="size-5" />
          <span class="sr-only">Open menu</span>
        </Button>

        <Show when={mobileOpen()}>
          <div class="absolute top-full right-0 mt-2 w-56 rounded-md border bg-popover p-1 shadow-md">
            <Show when={isLoggedIn()}>
              <A href="/dashboard" class="flex items-center p-2 rounded-sm hover:bg-accent" onClick={() => setMobileOpen(false)}>
                <Home class="mr-2 size-4" />
                Home
              </A>
              <A href="/app-store" class="flex items-center p-2 rounded-sm hover:bg-accent" onClick={() => setMobileOpen(false)}>
                <Store class="mr-2 size-4" />
                Store
              </A>
              <div class="my-1 h-px bg-border" />
              <A href="/settings" class="flex items-center p-2 rounded-sm hover:bg-accent" onClick={() => setMobileOpen(false)}>
                <Settings class="mr-2 size-4" />
                Settings
              </A>
              <div class="my-1 h-px bg-border" />
              <button
                type="button"
                class="flex items-center p-2 rounded-sm hover:bg-accent w-full text-left text-red-600"
                onClick={() => {
                  setMobileOpen(false);
                  handleLogout();
                }}
              >
                <LogOut class="mr-2 size-4" />
                Logout
              </button>
            </Show>
            <Show when={!isLoggedIn()}>
              <A href="/login" class="flex items-center p-2 rounded-sm hover:bg-accent" onClick={() => setMobileOpen(false)}>
                <LogIn class="mr-2 size-4" />
                Login
              </A>
            </Show>
          </div>
        </Show>
      </div>
    </header>
  );
}
