import { createResource, createSignal, Show, For } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { api } from '@/api-client';
import type { InstalledApp, CustomLink, AppStatus } from '@/api-client/types';
import { Card, CardContent, LoadingSpinner, Dialog, Input } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { AppLogo } from '@/components/app-logo/app-logo';
import { EmptyPage } from '@/components/empty-page/empty-page';
import { cn, limitText } from '@/lib/utils';
import { AppWindow, Link as LinkIcon, Download, RotateCw, AlertCircle } from 'lucide-solid';
import { toast } from '@/stores/toast-store';

// AppStatus component
function AppStatusBadge(props: { status: AppStatus; lite?: boolean }) {
  if (props.status === 'missing') return null;
  const dotClass = cn(
    'inline-block h-2 w-2 rounded-full',
    props.status === 'running' && 'bg-green-500 animate-pulse',
    props.status === 'stopped' && 'bg-red-500',
    props.status !== 'running' && props.status !== 'stopped' && 'bg-gray-400',
  );
  return (
    <div class="flex items-center" title={props.lite ? props.status : undefined}>
      <span class={dotClass} />
      <Show when={!props.lite}><span class="ml-2 text-sm text-muted-foreground">{props.status}</span></Show>
    </div>
  );
}

// AppTile component
function AppTile(props: { info: InstalledApp['info']; status: AppStatus; updateAvailable: boolean; pendingRestart?: boolean }) {
  return (
    <Card class="relative hover:bg-accent/50 transition-colors">
      <CardContent class="flex items-center gap-3 p-4">
        <AppLogo alt={`${props.info.name} logo`} urn={props.info.urn} size={60} />
        <div class="flex flex-col justify-center">
          <div class="flex items-center gap-2">
            <span class="font-bold">{props.info.name}</span>
            <AppStatusBadge lite status={props.status} />
          </div>
          <div class="text-muted-foreground text-sm">{limitText(props.info.short_desc, 50)}</div>
        </div>
      </CardContent>
      <Show when={props.pendingRestart}>
        <div class="absolute top-0 right-0 rounded-tr-lg rounded-bl-lg bg-amber-500 text-white p-1.5"><RotateCw size={20} /></div>
      </Show>
      <Show when={props.updateAvailable && !props.pendingRestart}>
        <div class="absolute top-0 right-0 rounded-tr-lg rounded-bl-lg bg-green-500 text-white p-1.5"><Download size={20} /></div>
      </Show>
      <Show when={props.info.deprecated && !props.updateAvailable && !props.pendingRestart}>
        <div class="absolute top-0 right-0 rounded-tr-lg rounded-bl-lg bg-red-500 text-white p-1.5"><AlertCircle size={20} /></div>
      </Show>
    </Card>
  );
}

// LinkTile
function LinkTile(props: { link: CustomLink }) {
  return (
    <Card class="hover:bg-accent/50 transition-colors">
      <CardContent class="flex items-center gap-3 p-4">
        <Show when={props.link.iconUrl} fallback={
          <div class="w-[60px] h-[60px] rounded-xl bg-muted flex items-center justify-center"><LinkIcon size={24} class="text-muted-foreground" /></div>
        }>
          <img src={props.link.iconUrl!} alt={props.link.title} class="w-[60px] h-[60px] rounded-xl object-cover" />
        </Show>
        <div class="flex flex-col justify-center">
          <span class="font-bold">{props.link.title}</span>
          <Show when={props.link.description}><span class="text-muted-foreground text-sm">{props.link.description}</span></Show>
        </div>
      </CardContent>
    </Card>
  );
}

// ButtonTile
function ButtonTile(props: { title: string; subtitle: string; action: () => void; icon: any; class?: string }) {
  return (
    <button type="button" onClick={props.action} class={cn('rounded-xl border-2 border-dashed border-muted-foreground/20 p-6 hover:bg-accent/30 transition-colors cursor-pointer w-full text-left', props.class)}>
      <div class="flex flex-col items-center text-center gap-2">
        {props.icon}
        <span class="font-semibold text-sm">{props.title}</span>
        <span class="text-xs text-muted-foreground">{props.subtitle}</span>
      </div>
    </button>
  );
}

// AddLinkDialog
function AddLinkDialog(props: { isOpen: boolean; onClose: () => void }) {
  const [title, setTitle] = createSignal('');
  const [url, setUrl] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [iconUrl, setIconUrl] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.createLink({ title: title(), url: url(), description: description() || null, iconUrl: iconUrl() || null });
      toast.success('Link added');
      props.onClose();
      setTitle(''); setUrl(''); setDescription(''); setIconUrl('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add link');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog isOpen={props.isOpen} onClose={props.onClose} title="Add Link">
      <form onSubmit={handleSubmit}>
        <Input label="Title" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} class="mb-3" placeholder="My Link" />
        <Input label="URL" value={url()} onInput={(e) => setUrl(e.currentTarget.value)} class="mb-3" placeholder="https://example.com" />
        <Input label="Description (optional)" value={description()} onInput={(e) => setDescription(e.currentTarget.value)} class="mb-3" />
        <Input label="Icon URL (optional)" value={iconUrl()} onInput={(e) => setIconUrl(e.currentTarget.value)} class="mb-3" />
        <div class="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={props.onClose} type="button">Cancel</Button>
          <Button type="submit" disabled={!title() || !url() || loading()}>{loading() ? 'Adding...' : 'Add Link'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function MyAppsPage() {
  const navigate = useNavigate();
  const [apps, { refetch: refetchApps }] = createResource(() => api.getInstalledApps());
  const [links, { refetch: refetchLinks }] = createResource(() => api.getLinks());
  const [addLinkOpen, setAddLinkOpen] = createSignal(false);

  const installed = () => apps()?.installed ?? [];
  const customLinks = () => links()?.links ?? [];

  return (
    <div class="h-full flex flex-col px-6 pt-4">
      <div class="flex-shrink-0 mb-6">
        <h2 class="text-2xl sm:text-3xl font-bold tracking-tight mb-1 text-foreground">My Apps</h2>
        <p class="text-lg text-muted-foreground">Manage your installed applications and links</p>
      </div>
      <div class="flex-1 overflow-y-auto min-h-0">
        <Show when={!apps.loading || apps()} fallback={<LoadingSpinner />}>
          <Show when={installed().length > 0 || customLinks().length > 0} fallback={
            <EmptyPage title="No apps installed" subtitle="Visit the App Store to install your first app" redirectPath="/app-store" actionLabel="Browse App Store"
              extraContent={
                <div class="flex flex-col sm:flex-row gap-2 justify-center mt-3">
                  <ButtonTile title="Custom App" subtitle="Add a Docker app" action={() => navigate('/apps/create')} icon={<AppWindow size={50} stroke-width={1.5} class="text-muted-foreground" />} class="w-full sm:w-1/2" />
                  <ButtonTile title="Add Link" subtitle="Add a custom link" action={() => setAddLinkOpen(true)} icon={<LinkIcon size={50} stroke-width={1.5} class="text-muted-foreground" />} class="w-full sm:w-1/2" />
                </div>
              }
            />
          }>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <For each={installed()}>
                {(item) => {
                  const versionIgnored = item.app.ignoredVersion === item.metadata.latestVersion;
                  const updateAvailable = Number(item.app.version) < Number(item.metadata.latestVersion) && !versionIgnored;
                  const [appName, storeId] = item.info.urn.split(':');
                  return (
                    <Show when={item.info.available}>
                      <A href={`/apps/${storeId}/${appName}`} class="no-underline text-inherit">
                        <AppTile info={item.info} status={item.app.status} updateAvailable={updateAvailable} pendingRestart={item.app.pendingRestart} />
                      </A>
                    </Show>
                  );
                }}
              </For>
              <For each={customLinks()}>
                {(link) => (
                  <a href={link.url} target="_blank" class="no-underline text-inherit">
                    <LinkTile link={link} />
                  </a>
                )}
              </For>
              <ButtonTile title="Custom App" subtitle="Add a Docker app" action={() => navigate('/apps/create')} icon={<AppWindow size={50} stroke-width={1.5} />} />
              <ButtonTile title="Add Link" subtitle="Add a custom link" action={() => setAddLinkOpen(true)} icon={<LinkIcon size={50} stroke-width={1.5} />} />
            </div>
          </Show>
        </Show>
      </div>
      <AddLinkDialog isOpen={addLinkOpen()} onClose={() => { setAddLinkOpen(false); refetchLinks(); }} />
    </div>
  );
}
