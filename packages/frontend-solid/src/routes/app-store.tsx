import { createSignal, createResource, Show, For, createEffect } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { api } from '@/api-client';
import type { AppSummary } from '@/api-client/types';
import { appStoreState } from '@/stores/app-store';
import { iconForCategory } from '@/modules/app/helpers/table-helpers';
import { GlassContainer, Skeleton } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { cn, limitText } from '@/lib/utils';
import { Search, LayoutGrid, RefreshCw, Check, Download } from 'lucide-solid';
import { toast } from '@/stores/toast-store';

function AppCard(props: { app: AppSummary; isLoading?: boolean; isInstalled?: boolean }) {
  if (props.isLoading) {
    return (
      <GlassContainer class="h-full p-4 flex flex-col min-h-[220px]" intensity="low">
        <div class="flex items-start justify-between mb-4"><Skeleton class="w-16 h-16 rounded-xl" /><Skeleton class="w-12 h-6 rounded-full" /></div>
        <Skeleton class="h-6 w-3/4 mb-2" /><Skeleton class="h-4 w-full mb-1" /><Skeleton class="h-4 w-2/3" />
      </GlassContainer>
    );
  }

  const [appId, storeId] = props.app.urn.split(':');
  const logoUrl = `/api/marketplace/apps/${props.app.urn}/image`;

  return (
    <A href={`/app-store/${storeId}/${appId}`} class="block h-full group">
      <GlassContainer class="h-full p-4 hover:bg-white/10 hover:shadow-lg transition-all active:scale-[0.98] flex flex-col min-h-[180px] sm:min-h-[220px]" intensity="low">
        <div class="flex items-start justify-between mb-3 sm:mb-4">
          <img src={logoUrl} alt={props.app.name} class="w-12 h-12 sm:w-16 sm:h-16 rounded-xl shadow-lg object-cover" width={64} height={64} loading="lazy" />
          <span class="px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-semibold">Free</span>
        </div>
        <h3 class="font-bold text-base sm:text-lg mb-1 truncate text-foreground group-hover:text-primary transition-colors">{props.app.name}</h3>
        <p class="text-sm text-muted-foreground line-clamp-2 mb-4 flex-grow">{limitText(props.app.short_desc, 80)}</p>
        <div class="flex items-center justify-end mt-auto">
          <Show when={props.isInstalled} fallback={
            <Button variant="ghost" size="icon" class="h-8 w-8 rounded-full p-0"><Download class="w-4 h-4" /></Button>
          }>
            <div class="h-8 w-8 rounded-full flex items-center justify-center bg-emerald-500/20">
              <Check class="w-4 h-4 text-emerald-500" />
            </div>
          </Show>
        </div>
      </GlassContainer>
    </A>
  );
}

export default function AppStorePage() {
  const _navigate = useNavigate();
  const { search, setSearch, category, setCategory, storeId, setStoreId } = appStoreState;
  const [localSearch, setLocalSearch] = createSignal(search());
  const [isPulling, setIsPulling] = createSignal(false);
  const [_cursor, _setCursor] = createSignal<string | undefined>();

  const [enabledStores] = createResource(() => api.getEnabledAppStores());
  const [installedApps] = createResource(() => api.getInstalledApps());

  // Set default store
  createEffect(() => {
    const stores = enabledStores()?.appStores;
    if (stores && !storeId()) {
      const ci = stores.find((s) => s.name === 'CI Marketplace');
      setStoreId(ci?.slug ?? stores[0]?.slug);
    }
  });

  const installedUrns = () => {
    const data = installedApps();
    if (!data?.installed) return new Set<string>();
    return new Set(data.installed.map((a) => a.info.urn));
  };

  const [appsData, { refetch }] = createResource(
    () => ({ search: search(), category: category() === '__alternatives__' ? undefined : category(), storeId: storeId(), cursor: _cursor() }),
    (params) => api.searchApps({ ...params, pageSize: 48 }),
  );

  const apps = () => appsData()?.data ?? [];

  const onSearch = (e: Event & { currentTarget: HTMLInputElement }) => {
    setLocalSearch(e.currentTarget.value);
    setSearch(e.currentTarget.value);
  };

  const pullApps = async () => {
    setIsPulling(true);
    try {
      await api.pullAppStores();
      refetch();
      toast.success('App stores synced');
    } catch {
      toast.error('Failed to sync app stores');
    } finally {
      setIsPulling(false);
    }
  };

  return (
    <div class="h-full flex flex-col">
      <div class="flex-shrink-0 px-6 pt-6 pb-2 flex justify-between items-start">
        <div>
          <h2 class="text-3xl font-bold tracking-tight mb-2 text-foreground">App Store</h2>
          <p class="text-muted-foreground">Discover and manage your applications</p>
        </div>
        <Button onClick={pullApps} disabled={isPulling()} variant="outline" size="sm" class="gap-2">
          <RefreshCw class={cn('h-4 w-4', isPulling() && 'animate-spin')} />
          {isPulling() ? 'Syncing...' : 'Check for Updates'}
        </Button>
      </div>

      <div class="flex flex-1 min-h-0 pt-4">
        {/* Sidebar */}
        <aside class="w-64 flex-shrink-0 border-r bg-muted/10 hidden md:flex flex-col ml-6 mb-6 rounded-2xl border">
          <div class="p-4 border-b">
            <div class="relative">
              <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground z-10" />
              <input
                placeholder="Search apps..."
                class="flex h-9 w-full rounded-md border border-input bg-transparent pl-9 pr-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring bg-muted/50"
                value={localSearch()}
                onInput={onSearch}
              />
            </div>
          </div>
          <div class="flex-1 overflow-y-auto py-4 px-2">
            <div class="space-y-1">
              <Button
                variant="ghost"
                class={cn('w-full justify-start font-normal text-sm gap-3 px-4 py-2 h-auto', !category() ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground')}
                onClick={() => setCategory(undefined)}
              >
                <LayoutGrid class="h-4 w-4" /><span>All</span>
              </Button>
              <div class="my-2 mx-3 border-t border-border/50" />
              <For each={iconForCategory}>
                {(cat) => {
                  const Icon = cat.icon;
                  const isSelected = () => category() === cat.id;
                  return (
                    <Button
                      variant="ghost"
                      class={cn('w-full justify-start font-normal text-sm gap-3 px-4 py-2 h-auto', isSelected() ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground')}
                      onClick={() => setCategory(cat.id)}
                    >
                      <Icon class="h-4 w-4" /><span class="truncate">{cat.id.charAt(0).toUpperCase() + cat.id.slice(1)}</span>
                    </Button>
                  );
                }}
              </For>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <div class="flex-1 overflow-y-auto min-h-0 px-6 py-4">
          {/* Mobile Search */}
          <div class="md:hidden space-y-4 mb-6">
            <div class="relative">
              <Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <input placeholder="Search apps..." class="flex h-9 w-full rounded-md border border-input bg-transparent pl-9 pr-3 py-1 text-sm shadow-sm bg-muted/50" value={localSearch()} onInput={onSearch} />
            </div>
            <div class="flex gap-2 overflow-x-auto pb-2 -mx-6 px-6">
              <Button variant="outline" size="sm" class={cn('rounded-full whitespace-nowrap', !category() ? 'bg-primary text-primary-foreground' : '')} onClick={() => setCategory(undefined)}>
                <LayoutGrid class="h-3.5 w-3.5 mr-1.5" />All
              </Button>
              <For each={iconForCategory}>
                {(cat) => {
                  const Icon = cat.icon;
                  return (
                    <Button variant="outline" size="sm" class={cn('rounded-full whitespace-nowrap', category() === cat.id ? 'bg-primary text-primary-foreground' : '')} onClick={() => setCategory(cat.id)}>
                      <Icon class="h-3.5 w-3.5 mr-1.5" />{cat.id.charAt(0).toUpperCase() + cat.id.slice(1)}
                    </Button>
                  );
                }}
              </For>
            </div>
          </div>

          <Show when={!appsData.loading && apps().length === 0}>
            <EmptyPage title="No apps found" subtitle="Try a different search or category" />
          </Show>

          <Show when={appsData.loading && apps().length === 0}>
            <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              <For each={Array.from({ length: 12 }, (_, i) => i)}>
                {() => <AppCard app={{ urn: 'loading:loading', name: '', short_desc: '', categories: [], available: true, created_at: 0, deprecated: false, id: '', supported_architectures: [] }} isLoading={true} />}
              </For>
            </div>
          </Show>

          <Show when={apps().length > 0}>
            <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              <For each={apps()}>
                {(app) => <AppCard app={app} isInstalled={installedUrns().has(app.urn)} />}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
