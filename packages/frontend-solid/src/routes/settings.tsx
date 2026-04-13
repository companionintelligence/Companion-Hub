import { createSignal, createResource, Show, For, Suspense } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { api } from '@/api-client';
import type { UserSettings, UserSettingsBody, AppStoreInfo } from '@/api-client/types';
import { useAppContext } from '@/context/app-context';
import { Tabs, TabsList, TabsTrigger, TabsContent, Card, CardHeader, CardTitle, CardContent, Input, Switch, Dialog, LoadingSpinner, Alert, Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { toast } from '@/stores/toast-store';
import { Key, Lock, User, LayoutGrid, RefreshCw, Trash, Plus, Settings as SettingsIcon, Globe, FileText } from 'lucide-solid';
import { cn } from '@/lib/utils';

// Change Password Form
function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = createSignal('');
  const [newPassword, setNewPassword] = createSignal('');
  const [confirmPassword, setConfirmPassword] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (newPassword() !== confirmPassword()) { toast.error('Passwords do not match'); return; }
    if (newPassword().length < 8) { toast.error('Password must be at least 8 characters'); return; }
    setLoading(true);
    try {
      await api.changePassword({ currentPassword: currentPassword(), newPassword: newPassword() });
      toast.success('Password changed successfully');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to change password'); }
    finally { setLoading(false); }
  };

  return (
    <form onSubmit={handleSubmit} class="space-y-3">
      <Input label="Current Password" type="password" value={currentPassword()} onInput={(e) => setCurrentPassword(e.currentTarget.value)} />
      <Input label="New Password" type="password" value={newPassword()} onInput={(e) => setNewPassword(e.currentTarget.value)} />
      <Input label="Confirm New Password" type="password" value={confirmPassword()} onInput={(e) => setConfirmPassword(e.currentTarget.value)} />
      <Button type="submit" disabled={loading()}>{loading() ? 'Changing...' : 'Change Password'}</Button>
    </form>
  );
}

// Change Username Form
function ChangeUsernameForm(props: { username?: string }) {
  const [newUsername, setNewUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [loading, setLoading] = createSignal(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.changeUsername({ newUsername: newUsername(), password: password() });
      toast.success('Username changed successfully');
      setNewUsername(''); setPassword('');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to change username'); }
    finally { setLoading(false); }
  };

  return (
    <form onSubmit={handleSubmit} class="space-y-3">
      <Show when={props.username}><p class="text-sm text-muted-foreground mb-2">Current: <strong>{props.username}</strong></p></Show>
      <Input label="New Username" type="email" value={newUsername()} onInput={(e) => setNewUsername(e.currentTarget.value)} placeholder="new@example.com" />
      <Input label="Current Password" type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
      <Button type="submit" disabled={loading()}>{loading() ? 'Changing...' : 'Change Username'}</Button>
    </form>
  );
}

// User Settings Form
function UserSettingsForm(props: { initialValues: UserSettings; onSave: () => void }) {
  const [domain, setDomain] = createSignal(props.initialValues.domain);
  const [localDomain, setLocalDomain] = createSignal(props.initialValues.localDomain);
  const [guestDashboard, setGuestDashboard] = createSignal(props.initialValues.guestDashboard);
  const [loading, setLoading] = createSignal(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.updateUserSettings({ domain: domain(), localDomain: localDomain(), guestDashboard: guestDashboard() });
      toast.success('Settings updated');
      props.onSave();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to update settings'); }
    finally { setLoading(false); }
  };

  return (
    <form onSubmit={handleSubmit} class="space-y-4">
      <Input label="Domain" value={domain()} onInput={(e) => setDomain(e.currentTarget.value)} placeholder="example.com" />
      <Input label="Local Domain" value={localDomain()} onInput={(e) => setLocalDomain(e.currentTarget.value)} placeholder="tipi.lan" />
      <Switch checked={guestDashboard()} onChange={setGuestDashboard} label="Enable Guest Dashboard" />
      <Button type="submit" disabled={loading()}>{loading() ? 'Saving...' : 'Save Settings'}</Button>
    </form>
  );
}

// App Stores Container
function AppStoresContainer() {
  const [stores, { refetch }] = createResource(() => api.getAllAppStores());
  const [isPulling, setIsPulling] = createSignal(false);
  const [addOpen, setAddOpen] = createSignal(false);
  const [newName, setNewName] = createSignal('');
  const [newUrl, setNewUrl] = createSignal('');

  const pull = async () => {
    setIsPulling(true);
    try { await api.pullAppStores(); toast.success('App stores synced'); refetch(); }
    catch { toast.error('Failed to sync'); }
    finally { setIsPulling(false); }
  };

  const addStore = async (e: Event) => {
    e.preventDefault();
    try { await api.createAppStore({ name: newName(), url: newUrl() }); toast.success('App store added'); setAddOpen(false); setNewName(''); setNewUrl(''); refetch(); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Failed to add store'); }
  };

  const deleteStore = async (id: number) => {
    if (!confirm('Delete this app store?')) return;
    try { await api.deleteAppStore(id); toast.success('Deleted'); refetch(); }
    catch { toast.error('Failed to delete'); }
  };

  return (
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold">App Stores</h3>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" onClick={pull} disabled={isPulling()}>
            <RefreshCw class={cn('h-4 w-4 mr-1', isPulling() && 'animate-spin')} />Sync
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}><Plus class="h-4 w-4 mr-1" />Add</Button>
        </div>
      </div>

      <Show when={stores()} fallback={<LoadingSpinner />}>
        {(data) => (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Name</TableHead><TableHead>URL</TableHead><TableHead class="w-20">Actions</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              <For each={data().appStores}>
                {(store) => (
                  <TableRow>
                    <TableCell class="font-medium">{store.name}</TableCell>
                    <TableCell class="text-sm text-muted-foreground truncate max-w-xs">{store.url}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => deleteStore(store.id)}><Trash class="h-4 w-4 text-destructive" /></Button>
                    </TableCell>
                  </TableRow>
                )}
              </For>
            </TableBody>
          </Table>
        )}
      </Show>

      <Dialog isOpen={addOpen()} onClose={() => setAddOpen(false)} title="Add App Store">
        <form onSubmit={addStore} class="space-y-3">
          <Input label="Name" value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} placeholder="My Store" />
          <Input label="Repository URL" value={newUrl()} onInput={(e) => setNewUrl(e.currentTarget.value)} placeholder="https://github.com/user/repo" />
          <div class="flex justify-end gap-2">
            <Button variant="outline" type="button" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!newName() || !newUrl()}>Add Store</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

// Hub Logs Container
function LogsContainer() {
  const [logs, setLogs] = createSignal<string[]>([]);

  // SSE for hub logs
  let eventSource: EventSource | null = null;
  const initSSE = () => {
    eventSource = new EventSource(`${window.location.origin}/api/sse/ci-hub-logs?maxLines=300`);
    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.lines) {
          setLogs((prev) => {
            const next = [...prev, ...data.lines.map((l: string) => l.trim())];
            return next.length > 300 ? next.slice(next.length - 300) : next;
          });
        }
      } catch { /* ignore */ }
    };
    eventSource.onerror = () => { eventSource?.close(); setTimeout(initSSE, 3000); };
  };
  initSSE();

  return (
    <div class="space-y-2">
      <h3 class="text-lg font-semibold">Hub Logs</h3>
      <div class="bg-black/80 text-green-400 font-mono text-xs p-4 rounded-lg h-96 overflow-y-auto">
        <For each={logs()} fallback={<p class="text-muted-foreground">Waiting for logs...</p>}>
          {(line) => <div class="whitespace-pre-wrap">{line}</div>}
        </For>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { appContext, refetch } = useAppContext();

  const currentTab = () => (searchParams.tab as string) || 'settings';
  const setTab = (tab: string) => setSearchParams({ tab });

  const userSettings = () => appContext().userSettings;
  const user = () => appContext().user;

  return (
    <div class="flex flex-col h-full">
      <div class="flex flex-col flex-1 overflow-hidden">
        <Tabs value={currentTab()} onValueChange={setTab} class="flex-1 flex flex-col h-full overflow-hidden">
          <div class="max-w-3xl mx-auto w-full">
            <TabsList class="bg-card/50 border border-border/50">
              <TabsTrigger value="settings" active={currentTab() === 'settings'} onClick={() => setTab('settings')}>General</TabsTrigger>
              <TabsTrigger value="security" active={currentTab() === 'security'} onClick={() => setTab('security')}>Security</TabsTrigger>
              <TabsTrigger value="appstores" active={currentTab() === 'appstores'} onClick={() => setTab('appstores')} class="hidden md:inline-flex">App Stores</TabsTrigger>
              <TabsTrigger value="logs" active={currentTab() === 'logs'} onClick={() => setTab('logs')} class="hidden md:inline-flex">Logs</TabsTrigger>
            </TabsList>
          </div>

          <div class="p-3 flex-1 overflow-y-auto min-h-0">
            <div class="max-w-3xl mx-auto w-full">
              <TabsContent value="settings" active={currentTab() === 'settings'}>
                <div class="space-y-6">
                  <Card>
                    <CardHeader><CardTitle class="text-xl">General Settings</CardTitle></CardHeader>
                    <CardContent>
                      <UserSettingsForm initialValues={userSettings()} onSave={refetch} />
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="security" active={currentTab() === 'security'}>
                <div class="space-y-6">
                  <Card>
                    <CardHeader>
                      <div class="flex items-center gap-2"><User class="h-5 w-5 text-muted-foreground" /><CardTitle class="text-xl">Change Username</CardTitle></div>
                    </CardHeader>
                    <CardContent><ChangeUsernameForm username={user().username} /></CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <div class="flex items-center gap-2"><Key class="h-5 w-5 text-muted-foreground" /><CardTitle class="text-xl">Change Password</CardTitle></div>
                    </CardHeader>
                    <CardContent><ChangePasswordForm /></CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="appstores" active={currentTab() === 'appstores'}>
                <AppStoresContainer />
              </TabsContent>

              <TabsContent value="logs" active={currentTab() === 'logs'}>
                <LogsContainer />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
