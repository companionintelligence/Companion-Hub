import type { ParentComponent } from 'solid-js';
import { Header } from '@/components/header/header';

/** Suspense/loading variant of the dashboard layout (no auth data yet) */
export const DashboardLayoutSuspense: ParentComponent = (props) => {
  return (
    <div class="flex bg-background overflow-hidden w-screen flex-col" style={{ height: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <Header isLoggedIn={false} isUpdateAvailable={false} />
      <div class="flex flex-1 flex-col pt-24 px-4 container mx-auto h-full overflow-y-auto">
        <div class="rounded-xl border bg-card text-card-foreground shadow p-6">{props.children}</div>
      </div>
    </div>
  );
};

/** Main authenticated dashboard layout */
export const DashboardLayout: ParentComponent<{
  isLoggedIn: boolean;
  isUpdateAvailable: boolean;
}> = (props) => {
  return (
    <div class="flex bg-background overflow-hidden w-screen flex-col" style={{ height: 'calc(100vh - var(--titlebar-height, 0px))' }}>
      <Header isLoggedIn={props.isLoggedIn} isUpdateAvailable={props.isUpdateAvailable} />

      <main class="flex-1 relative pt-24 px-4 container mx-auto h-full overflow-y-auto overflow-x-hidden">{props.children}</main>
    </div>
  );
};
