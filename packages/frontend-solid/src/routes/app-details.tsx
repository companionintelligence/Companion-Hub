import { createResource, createSignal, Show, For, Switch, Match } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { api } from '@/api-client';
import type { AppStatus, AppInfo, AppDetails as AppDetailsType, AppMetadata } from '@/api-client/types';
import { GlassContainer, LoadingSpinner, Tabs, TabsList, TabsTrigger, TabsContent, Dialog, Card, CardContent } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { toast } from '@/stores/toast-store';
import { Play, Pause, RotateCw, Trash, ExternalLink, Download, MoreHorizontal, Settings, Eraser, AlertCircle, Loader2 } from 'lucide-solid';

// AppStatus badge
function AppStatusBadge(props: { status: AppStatus }) {
  if (props.status === 'missing') return null;
  const dotClass = cn(
    'inline-block h-2 w-2 rounded-full',
    props.status === 'running' && 'bg-green-500 animate-pulse',
    props.status === 'stopped' && 'bg-red-500',
    !['running', 'stopped'].includes(props.status) && 'bg-gray-400 animate-pulse',
  );
  const label = props.status.charAt(0).toUpperCase() + props.status.slice(1);
  return (
    <div class="flex items-center gap-2">
      <span class={dotClass} />
      <span class="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

// App Actions
function AppActions(props: { app: AppDetailsType | null; info: AppInfo; metadata: AppMetadata; onRefetch: () => void }) {
  const [actionLoading, setActionLoading] = createSignal<string | null>(null);
  const [showMenu, setShowMenu] = createSignal(false);
  const [confirmDialog, setConfirmDialog] = createSignal<{ title: string; message: string; action: () => Promise<void> } | null>(null);
  const navigate = useNavigate();

  const doAction = async (name: string, fn: () => Promise<void>) => {
    setActionLoading(name);
    try {
      await fn();
      props.onRefetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${name} failed`);
    } finally {
      setActionLoading(null);
    }
  };

  const status = () => props.app?.status ?? 'missing';
  const isLoading = () => ['installing', 'uninstalling', 'starting', 'stopping', 'restarting', 'updating', 'resetting', 'backing_up', 'restoring'].includes(status());
  const updateAvailable = () => Number(props.app?.version ?? 0) < Number(props.metadata?.latestVersion || 0);

  const openApp = () => {
    if (props.app?.domain) {
      window.open(`https://${props.app.domain}${props.info.url_suffix || ''}`, '_blank');
    } else if (props.app?.port) {
      const protocol = props.info.https ? 'https' : 'http';
      window.open(`${protocol}://${window.location.hostname}:${props.app.port}${props.info.url_suffix || ''}`, '_blank');
    }
  };

  return (
    <>
      <div class="flex flex-wrap gap-2">
        <Switch>
          <Match when={status() === 'missing'}>
            <Button onClick={() => doAction('install', () => api.installApp(props.info.urn, {}))} disabled={!!actionLoading()}>
              {actionLoading() === 'install' ? 'Installing...' : 'Install'}
            </Button>
          </Match>
          <Match when={status() === 'stopped'}>
            <Button onClick={() => doAction('start', () => api.startApp(props.info.urn))} disabled={!!actionLoading()}>
              <Play class="mr-1" size={14} />{actionLoading() === 'start' ? 'Starting...' : 'Start'}
            </Button>
          </Match>
          <Match when={status() === 'running'}>
            <Button variant="outline" onClick={() => setConfirmDialog({ title: 'Stop App', message: `Stop ${props.info.name}?`, action: () => api.stopApp(props.info.urn) })}>
              <Pause class="mr-1" size={14} />Stop
            </Button>
            <Show when={!props.info.no_gui}>
              <Button onClick={openApp}><ExternalLink class="mr-1" size={14} />Open</Button>
            </Show>
          </Match>
          <Match when={isLoading()}>
            <Button disabled><Loader2 class="mr-1 animate-spin" size={14} />{status().replace(/_/g, ' ')}...</Button>
          </Match>
        </Switch>

        <Show when={status() !== 'missing'}>
          <div class="relative">
            <Button variant="outline" size="icon" onClick={() => setShowMenu(!showMenu())}>
              <MoreHorizontal size={14} />
              <Show when={updateAvailable() || props.app?.pendingRestart}>
                <span class="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-red-500" />
              </Show>
            </Button>
            <Show when={showMenu()}>
              <div class="absolute top-full right-0 mt-1 w-48 rounded-md border bg-popover p-1 shadow-md z-50">
                <Show when={status() === 'running'}>
                  <button type="button" class="flex items-center w-full p-2 rounded-sm hover:bg-accent text-sm cursor-pointer" onClick={() => { setShowMenu(false); setConfirmDialog({ title: 'Restart App', message: `Restart ${props.info.name}?`, action: () => api.restartApp(props.info.urn) }); }}>
                    <RotateCw class="mr-2" size={14} />Restart
                  </button>
                </Show>
                <Show when={updateAvailable()}>
                  <button type="button" class="flex items-center w-full p-2 rounded-sm hover:bg-accent text-sm cursor-pointer" onClick={() => { setShowMenu(false); doAction('update', () => api.updateApp(props.info.urn)); }}>
                    <Download class="mr-2" size={14} />Update
                  </button>
                </Show>
                <div class="my-1 h-px bg-border" />
                <button type="button" class="flex items-center w-full p-2 rounded-sm hover:bg-accent text-sm text-amber-600 cursor-pointer" onClick={() => { setShowMenu(false); setConfirmDialog({ title: 'Reset App', message: `Reset ${props.info.name}? This will remove all app data.`, action: () => api.resetApp(props.info.urn) }); }}>
                  <Eraser class="mr-2" size={14} />Reset
                </button>
                <button type="button" class="flex items-center w-full p-2 rounded-sm hover:bg-accent text-sm text-destructive cursor-pointer" onClick={() => { setShowMenu(false); setConfirmDialog({ title: 'Uninstall App', message: `Uninstall ${props.info.name}? This action cannot be undone.`, action: () => api.uninstallApp(props.info.urn) }); }}>
                  <Trash class="mr-2" size={14} />Uninstall
                </button>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={confirmDialog()}>
        {(dialog) => (
          <Dialog isOpen={true} onClose={() => setConfirmDialog(null)} title={dialog().title}>
            <p class="text-sm text-muted-foreground mb-4">{dialog().message}</p>
            <div class="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmDialog(null)}>Cancel</Button>
              <Button variant="destructive" onClick={async () => { await doAction('action', dialog().action); setConfirmDialog(null); }}>Confirm</Button>
            </div>
          </Dialog>
        )}
      </Show>
    </>
  );
}

// App Details Tabs
function AppDetailsTabs(props: { info: AppInfo; app: AppDetailsType | null; metadata: AppMetadata }) {
  const [tab, setTab] = createSignal('overview');
  const [backups] = createResource(() => props.app ? api.getAppBackups(props.info.urn).catch(() => ({ data: [] })) : { data: [] });

  return (
    <div>
      <Tabs value={tab()} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview" active={tab() === 'overview'} onClick={() => setTab('overview')}>Overview</TabsTrigger>
          <Show when={props.app}>
            <TabsTrigger value="logs" active={tab() === 'logs'} onClick={() => setTab('logs')}>Logs</TabsTrigger>
            <TabsTrigger value="backups" active={tab() === 'backups'} onClick={() => setTab('backups')}>Backups</TabsTrigger>
          </Show>
        </TabsList>

        <TabsContent value="overview" active={tab() === 'overview'}>
          <div class="p-4 space-y-4">
            <Show when={props.info.description}>
              <div>
                <h3 class="font-semibold mb-2">Description</h3>
                <p class="text-sm text-muted-foreground whitespace-pre-wrap">{props.info.description}</p>
              </div>
            </Show>
            <div class="grid grid-cols-2 gap-4 text-sm">
              <div><span class="text-muted-foreground">Version:</span> <span class="font-medium">{props.info.version}</span></div>
              <div><span class="text-muted-foreground">Author:</span> <span class="font-medium">{props.info.author}</span></div>
              <div><span class="text-muted-foreground">Source:</span> <a href={props.info.source} target="_blank" class="text-primary hover:underline">{props.info.source ? 'View Source' : 'N/A'}</a></div>
              <div><span class="text-muted-foreground">Website:</span> <a href={props.info.website} target="_blank" class="text-primary hover:underline">{props.info.website ? 'Visit' : 'N/A'}</a></div>
              <Show when={props.info.categories.length > 0}>
                <div class="col-span-2"><span class="text-muted-foreground">Categories:</span> <span class="font-medium">{props.info.categories.join(', ')}</span></div>
              </Show>
              <Show when={props.metadata.latestVersion}>
                <div><span class="text-muted-foreground">Latest:</span> <span class="font-medium">{props.metadata.latestVersion}</span></div>
              </Show>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="logs" active={tab() === 'logs'}>
          <div class="p-4">
            <p class="text-sm text-muted-foreground">Log streaming available via SSE events when app is running.</p>
          </div>
        </TabsContent>

        <TabsContent value="backups" active={tab() === 'backups'}>
          <div class="p-4 space-y-2">
            <Show when={backups()?.data?.length} fallback={<p class="text-sm text-muted-foreground">No backups yet.</p>}>
              <For each={backups()?.data ?? []}>
                {(backup) => (
                  <Card>
                    <CardContent class="flex items-center justify-between p-3">
                      <div>
                        <span class="text-sm font-medium">{backup.id}</span>
                        <span class="text-xs text-muted-foreground ml-2">{backup.date}</span>
                      </div>
                      <div class="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => api.restoreAppBackup(props.info.urn, backup.id).then(() => toast.success('Restored')).catch(() => toast.error('Restore failed'))}>Restore</Button>
                        <Button size="sm" variant="destructive" onClick={() => api.deleteAppBackup(props.info.urn, backup.id).then(() => toast.success('Deleted')).catch(() => toast.error('Delete failed'))}>Delete</Button>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </For>
            </Show>
            <Show when={props.app}>
              <Button variant="outline" onClick={() => api.backupApp(props.info.urn).then(() => toast.success('Backup started')).catch(() => toast.error('Backup failed'))}>Create Backup</Button>
            </Show>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Main App Details Page
export default function AppDetailsPage() {
  const params = useParams();
  const appUrn = () => `${params.appId}:${params.storeId}`;

  const [appData, { refetch }] = createResource(appUrn, (urn) => api.getApp(urn));

  const logoUrl = () => appData()?.info?.urn ? `/api/marketplace/apps/${appData()?.info.urn}/image` : '/app-not-found.jpg';

  return (
    <div class="h-full overflow-y-auto w-full">
      <Show when={appData()} fallback={<LoadingSpinner />}>
        {(data) => (
          <div class="max-w-5xl mx-auto space-y-5 sm:space-y-8 pb-20 px-4 pt-4 sm:p-6 md:p-10">
            {/* Header */}
            <div class="flex flex-row gap-4 sm:gap-8 items-start">
              <div class="flex-shrink-0">
                <img src={logoUrl()} alt={data().info?.name} class="w-20 h-20 sm:w-32 sm:h-32 md:w-48 md:h-48 rounded-2xl sm:rounded-3xl shadow-2xl object-cover bg-white/10" />
              </div>
              <div class="flex-1 space-y-2 sm:space-y-4 min-w-0">
                <div>
                  <h1 class="text-2xl sm:text-4xl font-bold mb-1 sm:mb-2 tracking-tight">{data().info?.name}</h1>
                  <div class="flex items-center gap-2 sm:gap-3 flex-wrap">
                    <span class="text-xs sm:text-sm font-medium px-2 py-0.5 sm:py-1 rounded-md bg-white/10 text-white/80">v{data().info?.version}</span>
                    <AppStatusBadge status={data().app?.status ?? 'missing'} />
                  </div>
                </div>
                <p class="text-sm sm:text-lg text-muted-foreground leading-relaxed max-w-2xl">{data().info?.short_desc}</p>
                <div class="pt-1 sm:pt-2">
                  <AppActions app={data().app} info={data().info} metadata={data().metadata} onRefetch={refetch} />
                </div>
              </div>
            </div>

            {/* Tabs */}
            <GlassContainer class="p-1 md:p-2 min-h-[300px] sm:min-h-[500px]">
              <AppDetailsTabs info={data().info} app={data().app} metadata={data().metadata} />
            </GlassContainer>
          </div>
        )}
      </Show>
    </div>
  );
}
