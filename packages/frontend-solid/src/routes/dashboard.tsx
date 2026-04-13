import { createResource, createSignal, Show, For, onCleanup } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { api } from '@/api-client';
import type { AppStatus, LoadDto } from '@/api-client/types';
import { GlassContainer, LoadingSpinner } from '@/components/ui/shared';
import { Button } from '@/components/ui/Button';
import { AppLogo } from '@/components/app-logo/app-logo';
import { Cpu, Database, LayoutGrid, MemoryStick, Loader2, X } from 'lucide-solid';
import { cn } from '@/lib/utils';

// CompactSystemStat
function CompactSystemStat(props: { title: string; metric: string; icon: typeof Cpu; progress: number; color?: 'blue' | 'red' | 'green' }) {
  const colorMap = { blue: 'bg-blue-500', red: 'bg-red-500', green: 'bg-green-500' };
  const Icon = props.icon;
  return (
    <GlassContainer intensity="high" class="p-3 sm:p-5">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{props.title}</span>
        <Icon size={18} class="text-muted-foreground" />
      </div>
      <div class="text-lg sm:text-2xl font-bold mb-3">{props.metric}</div>
      <div class="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div
          class={cn('h-full rounded-full transition-all duration-500', colorMap[props.color ?? 'blue'])}
          style={{ width: `${Math.min(props.progress, 100)}%` }}
          role="progressbar"
        />
      </div>
    </GlassContainer>
  );
}

// SimpleAppTile
const FAILED_STATUSES: AppStatus[] = ['stopped', 'missing'];

function SimpleAppTile(props: { name: string; urn: string; status?: AppStatus; isInstalling?: boolean }) {
  const isFailed = () => props.status != null && FAILED_STATUSES.includes(props.status);
  const hasOverlay = () => props.isInstalling || isFailed();

  return (
    <div class="flex flex-col items-center text-center p-2 cursor-pointer hover:opacity-80 transition-opacity w-full">
      <div class="mb-2 relative">
        <AppLogo urn={props.urn} alt={props.name} size={56} class={`rounded-xl shadow-sm${hasOverlay() ? ' opacity-40' : ''}`} />
        <Show when={props.isInstalling}>
          <div class="absolute inset-0 flex items-center justify-center">
            <Loader2 class="w-6 h-6 text-primary animate-spin" />
          </div>
        </Show>
        <Show when={isFailed() && !props.isInstalling}>
          <div class="absolute inset-0 flex items-center justify-center">
            <div class="flex items-center justify-center w-7 h-7 rounded-full bg-red-500/90">
              <X class="w-5 h-5 text-white" stroke-width={3} />
            </div>
          </div>
        </Show>
      </div>
      <div class="truncate w-full font-medium text-xs sm:text-sm" title={props.name}>{props.name}</div>
      <Show when={props.isInstalling}>
        <div class="w-full mt-1 h-1 rounded-full bg-muted overflow-hidden">
          <div class="h-full bg-primary rounded-full animate-pulse w-2/3" />
        </div>
      </Show>
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();

  // Poll system load every 3s
  const [systemData, setSystemData] = createSignal<LoadDto | null>(null);
  const [appsData] = createResource(() => api.getInstalledApps());

  const fetchLoad = async () => {
    try { setSystemData(await api.systemLoad()); } catch { /* ignore */ }
  };
  fetchLoad();
  const interval = setInterval(fetchLoad, 3000);
  onCleanup(() => clearInterval(interval));

  return (
    <div class="h-full overflow-y-auto">
      <div class="flex flex-col items-center gap-6 py-6">
        {/* System Stats */}
        <div class="grid grid-cols-3 gap-2 sm:gap-4 w-full max-w-2xl px-2 sm:px-4">
          <Show when={systemData()} fallback={<div class="col-span-3"><LoadingSpinner /></div>}>
            {(data) => (
              <>
                <CompactSystemStat title="Disk" metric={`${data().diskUsed} GB`} icon={Database} progress={data().percentUsed} color="blue" />
                <CompactSystemStat title="CPU" metric={`${data().cpuLoad.toFixed(2)}%`} icon={Cpu} progress={data().cpuLoad} color="red" />
                <CompactSystemStat title="Memory" metric={`${data().percentUsedMemory}%`} icon={MemoryStick} progress={data().percentUsedMemory} color="green" />
              </>
            )}
          </Show>
        </div>

        {/* Apps List */}
        <div class="w-full max-w-2xl px-2 sm:px-4">
          <Show when={appsData()} fallback={<LoadingSpinner />}>
            {(data) => (
              <Show when={data().installed.length > 0} fallback={
                <A href="/app-store" class="flex justify-center items-center no-underline py-16 w-full">
                  <h1 class="text-center text-xl sm:text-3xl text-muted-foreground/30 font-medium px-4">
                    Click here to install your first app
                  </h1>
                </A>
              }>
                <div class="grid gap-3 py-2 px-1" style={{ "grid-template-columns": 'repeat(auto-fill, minmax(100px, 1fr))' }}>
                  <For each={data().installed}>
                    {(item) => {
                      const [appName, storeId] = item.info.urn.split(':');
                      return (
                        <A href={`/apps/${storeId}/${appName}`} class="no-underline text-inherit">
                          <SimpleAppTile
                            name={item.info.name}
                            urn={item.info.urn}
                            status={item.app.status}
                            isInstalling={item.app.status === 'installing'}
                          />
                        </A>
                      );
                    }}
                  </For>
                </div>
              </Show>
            )}
          </Show>
        </div>

        {/* App Store Button */}
        <Button size="sm" class="flex items-center gap-2" onClick={() => navigate('/app-store')}>
          <LayoutGrid size={20} />
          App Store
        </Button>
      </div>
    </div>
  );
}
