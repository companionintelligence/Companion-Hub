import { apiFetch } from '@/lib/api-fetch';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Container,
} from 'lucide-react';
import { useState } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: Array<{ hostPort: number | null; containerPort: number; protocol: string }>;
  appUrn: string | null;
  created: number;
  uptime: string;
}

interface PortStatus {
  hostPort: number;
  containerPort: number;
  protocol: string;
  label: string;
  appUrn: string;
  bound: boolean;
  containerName: string | null;
  containerState: string | null;
}

interface SystemHealth {
  cpu: { load: number; cores: number; model: string };
  memory: { total: number; used: number; free: number; percent: number };
  disk: { total: number; used: number; free: number; percent: number };
  uptime: number;
  platform: string;
  hostname: string;
  dockerVersion: string | null;
  containerCount: { running: number; stopped: number; total: number };
  hostResources?: {
    hasVmWedge: boolean;
    runtimeKind: string;
    hostMemoryTotalGb: number;
    hostMemoryUsedGb: number;
    hostDiskTotalGb: number;
    hostDiskUsedGb: number;
    containerMemoryTotalGb?: number;
    containerMemoryUsedGb?: number;
    containerDiskTotalGb?: number;
    containerDiskUsedGb?: number;
    recommendedDockerRamMb?: number;
    tuningNotes?: string;
    platformGuidance: string;
  };
}

interface InspectionData {
  containers: ContainerInfo[];
  ports: { allocations: PortStatus[]; untracked: Array<{ port: number; process: string }> };
  health: SystemHealth;
  timestamp: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
};

const formatUptime = (seconds: number) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

// ─── Shared Components ───────────────────────────────────────────────────────

const ProgressBar = ({ percent }: { percent: number }) => {
  const barColor = percent > 90 ? 'bg-red-500' : percent > 70 ? 'bg-yellow-500' : 'bg-primary';
  return (
    <div className="w-full h-1.5 bg-foreground/10 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${Math.min(percent, 100)}%` }} />
    </div>
  );
};

const StatCard = ({
  icon: Icon,
  title,
  value,
  subtitle,
  percent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string;
  subtitle?: string;
  percent?: number;
}) => (
  <div className="flex items-start gap-3">
    <span className="mt-0.5 text-primary">
      <Icon className="h-6 w-6" />
    </span>
    <div className="min-w-0 flex-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="truncate text-sm font-semibold">{value}</div>
      {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
      {percent !== undefined && (
        <div className="mt-1.5">
          <ProgressBar percent={percent} />
        </div>
      )}
    </div>
  </div>
);

const StateIcon = ({ state }: { state: string }) => {
  if (state === 'running') return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  if (state === 'exited') return <XCircle className="h-4 w-4 text-red-500" />;
  return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
};

const Badge = ({ children, variant = 'default' }: { children: React.ReactNode; variant?: 'default' | 'success' | 'danger' | 'warning' }) => {
  const colors = {
    default: 'bg-muted text-muted-foreground',
    success: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    danger: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    warning: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${colors[variant]}`}>{children}</span>;
};

const HostResourcesSection = ({ hostResources }: { hostResources: NonNullable<SystemHealth['hostResources']> }) => (
  <section className="rounded-3xl border border-border bg-linear-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
    <div className="flex items-center gap-3 mb-5">
      <Server className="h-6 w-6 text-primary" />
      <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">Host vs Container Resources</h2>
      {hostResources.hasVmWedge && <Badge variant="warning">VM wedge detected</Badge>}
    </div>

    <div className="rounded-xl border border-border bg-muted/30 p-4 mb-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-2">Docker resource limits</div>
      <p className="text-sm text-muted-foreground leading-relaxed">{hostResources.platformGuidance}</p>
      {hostResources.recommendedDockerRamMb && (
        <p className="text-sm font-medium mt-2">Recommended Docker memory: {Math.round(hostResources.recommendedDockerRamMb / 1024)} GB</p>
      )}
    </div>

    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 border-t border-border pt-5">
      <div className="rounded-xl border border-border p-4">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-2">Physical host</div>
        <div className="text-sm">
          Memory: {hostResources.hostMemoryUsedGb} / {hostResources.hostMemoryTotalGb} GB
        </div>
        <div className="text-sm">
          Disk: {hostResources.hostDiskUsedGb} / {hostResources.hostDiskTotalGb} GB
        </div>
      </div>
      {hostResources.hasVmWedge && (
        <div className="rounded-xl border border-border p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-2">Docker / VM allocated</div>
          <div className="text-sm">
            Memory: {hostResources.containerMemoryUsedGb ?? '—'} / {hostResources.containerMemoryTotalGb ?? '—'} GB
          </div>
          <div className="text-sm">
            Disk: {hostResources.containerDiskUsedGb ?? '—'} / {hostResources.containerDiskTotalGb ?? '—'} GB
          </div>
          {hostResources.recommendedDockerRamMb && (
            <div className="text-xs text-muted-foreground mt-2">
              Recommended Docker memory: {Math.round(hostResources.recommendedDockerRamMb / 1024)} GB
            </div>
          )}
        </div>
      )}
    </div>

    {hostResources.tuningNotes && <div className="mt-4 text-xs text-muted-foreground border-t border-border pt-4">{hostResources.tuningNotes}</div>}
  </section>
);

// ─── System Health Section ───────────────────────────────────────────────────

const SystemHealthSection = ({ health }: { health: SystemHealth }) => (
  <section className="rounded-3xl border border-border bg-linear-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
    <div className="flex items-center gap-3 mb-5">
      <Activity className="h-6 w-6 text-primary" />
      <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">System Health</h2>
    </div>

    <div className="grid grid-cols-2 gap-x-4 gap-y-5 border-t border-border pt-5 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard icon={Cpu} title="CPU" value={`${health.cpu.load}%`} subtitle={`${health.cpu.cores} cores`} percent={health.cpu.load} />
      <StatCard
        icon={MemoryStick}
        title="Memory"
        value={`${health.memory.percent}%`}
        subtitle={`${formatBytes(health.memory.used)} / ${formatBytes(health.memory.total)}`}
        percent={health.memory.percent}
      />
      <StatCard
        icon={HardDrive}
        title="Disk"
        value={`${health.disk.percent}%`}
        subtitle={`${formatBytes(health.disk.used * 1024 * 1024 * 1024)} / ${formatBytes(health.disk.total * 1024 * 1024 * 1024)}`}
        percent={health.disk.percent}
      />
      <StatCard icon={Clock} title="Uptime" value={formatUptime(health.uptime)} subtitle={health.platform} />
    </div>

    <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-5 sm:grid-cols-4 text-sm">
      <div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-0.5">Hostname</div>
        <div className="text-xs truncate font-medium" title={health.hostname}>
          {health.hostname}
        </div>
      </div>
      <div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-0.5">Docker</div>
        <div className="font-mono text-xs">{health.dockerVersion || 'N/A'}</div>
      </div>
      <div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-0.5">Containers</div>
        <div className="flex gap-1.5 items-center flex-wrap">
          <Badge variant="success">{health.containerCount.running} running</Badge>
          {health.containerCount.stopped > 0 && <Badge variant="danger">{health.containerCount.stopped} stopped</Badge>}
        </div>
      </div>
      <div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-0.5">CPU Model</div>
        <div className="text-xs truncate font-medium" title={health.cpu.model}>
          {health.cpu.model}
        </div>
      </div>
    </div>
  </section>
);

// ─── Containers Section ─────────────────────────────────────────────────────

const ContainersSection = ({ containers }: { containers: ContainerInfo[] }) => {
  const running = containers.filter((c) => c.state === 'running');
  const stopped = containers.filter((c) => c.state !== 'running');
  const sorted = [...running, ...stopped];

  return (
    <section className="rounded-3xl border border-border bg-linear-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-3 mb-5">
        <Container className="h-6 w-6 text-primary shrink-0" />
        <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">Docker Containers</h2>
        <Badge>{containers.length} total</Badge>
      </div>

      {sorted.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-xl border border-dashed p-4 text-center">No containers found</div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-2 pl-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Container</th>
                  <th className="text-left p-2 font-medium text-muted-foreground hidden md:table-cell">Image</th>
                  <th className="text-left p-2 font-medium text-muted-foreground hidden sm:table-cell">Ports</th>
                  <th className="text-left p-2 font-medium text-muted-foreground hidden sm:table-cell">Uptime</th>
                  <th className="text-left p-2 pr-3 font-medium text-muted-foreground hidden lg:table-cell">App</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="p-2 pl-3">
                      <StateIcon state={c.state} />
                    </td>
                    <td className="p-2 max-w-[120px] sm:max-w-none">
                      <div className="font-mono text-xs truncate">{c.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{c.id}</div>
                    </td>
                    <td className="p-2 hidden md:table-cell">
                      <div className="font-mono text-xs truncate max-w-[200px]" title={c.image}>
                        {c.image.split('/').pop()?.split(':')[0] || c.image}
                      </div>
                    </td>
                    <td className="p-2 hidden sm:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {c.ports
                          .filter((p) => p.hostPort)
                          .map((p, _i) => (
                            <Badge key={`${p.hostPort}-${p.containerPort}-${p.protocol}`} variant={c.state === 'running' ? 'success' : 'default'}>
                              {p.hostPort}→{p.containerPort}
                            </Badge>
                          ))}
                        {c.ports.filter((p) => p.hostPort).length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                      </div>
                    </td>
                    <td className="p-2 hidden sm:table-cell">
                      <span className="text-xs text-muted-foreground">{c.uptime}</span>
                    </td>
                    <td className="p-2 pr-3 hidden lg:table-cell">
                      {c.appUrn ? (
                        <Badge variant="default">{c.appUrn.split(':')[0]}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">system</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
};

// ─── Port Management Section ─────────────────────────────────────────────────

const PortManagementSection = ({ ports }: { ports: { allocations: PortStatus[]; untracked: Array<{ port: number; process: string }> } }) => {
  const [showUntracked, setShowUntracked] = useState(true);

  return (
    <section className="rounded-3xl border border-border bg-linear-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <Network className="h-6 w-6 text-primary shrink-0" />
        <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">Port Allocations</h2>
        <Badge>{ports.allocations.length} managed</Badge>
        {ports.untracked.length > 0 && (
          <button type="button" onClick={() => setShowUntracked(!showUntracked)} className="ml-auto">
            <Badge variant="warning">{ports.untracked.length} untracked</Badge>
          </button>
        )}
      </div>

      {ports.allocations.length === 0 && ports.untracked.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-xl border border-dashed p-4 text-center">
          No port allocations yet. Install an app to see port assignments here.
        </div>
      ) : (
        <>
          {/* Desktop: Table */}
          <div className="rounded-lg border overflow-hidden hidden sm:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-2 pl-3 font-medium text-muted-foreground">Status</th>
                    <th className="text-left p-2 font-medium text-muted-foreground">Host Port</th>
                    <th className="text-left p-2 font-medium text-muted-foreground">→ Container</th>
                    <th className="text-left p-2 font-medium text-muted-foreground">Protocol</th>
                    <th className="text-left p-2 font-medium text-muted-foreground">Label</th>
                    <th className="text-left p-2 font-medium text-muted-foreground">App</th>
                    <th className="text-left p-2 pr-3 font-medium text-muted-foreground hidden md:table-cell">Container</th>
                  </tr>
                </thead>
                <tbody>
                  {ports.allocations.map((p) => (
                    <tr key={`${p.hostPort}-${p.protocol}`} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="p-2 pl-3">
                        {p.bound ? (
                          <span title="Port is bound and active">
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                          </span>
                        ) : (
                          <span title="Port allocated but not bound">
                            <XCircle className="h-4 w-4 text-muted-foreground" />
                          </span>
                        )}
                      </td>
                      <td className="p-2 font-mono text-xs font-semibold">{p.hostPort}</td>
                      <td className="p-2 font-mono text-xs">{p.containerPort}</td>
                      <td className="p-2">
                        <Badge variant={p.protocol === 'udp' ? 'warning' : 'default'}>{p.protocol.toUpperCase()}</Badge>
                      </td>
                      <td className="p-2 text-xs">{p.label}</td>
                      <td className="p-2">
                        <Badge>{p.appUrn.split(':')[0]}</Badge>
                      </td>
                      <td className="p-2 pr-3 hidden md:table-cell font-mono text-xs text-muted-foreground">{p.containerName || '-'}</td>
                    </tr>
                  ))}
                  {showUntracked &&
                    ports.untracked.map((u) => (
                      <tr
                        key={`untracked-${u.port}`}
                        className="border-b last:border-0 bg-yellow-50/50 dark:bg-yellow-900/10 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 transition-colors"
                      >
                        <td className="p-2 pl-3">
                          <span title="Untracked port">
                            <AlertTriangle className="h-4 w-4 text-yellow-500" />
                          </span>
                        </td>
                        <td className="p-2 font-mono text-xs font-semibold">{u.port}</td>
                        <td className="p-2 font-mono text-xs text-muted-foreground">-</td>
                        <td className="p-2">
                          <Badge variant="warning">?</Badge>
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">untracked</td>
                        <td className="p-2 text-xs text-muted-foreground">-</td>
                        <td className="p-2 pr-3 hidden md:table-cell font-mono text-xs">{u.process}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile: Card list */}
          <div className="sm:hidden flex flex-col gap-2">
            {ports.allocations.map((p) => (
              <div key={`m-${p.hostPort}-${p.protocol}`} className="rounded-lg border p-3 flex items-center gap-3">
                {p.bound ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold">
                      {p.hostPort}→{p.containerPort}
                    </span>
                    <Badge variant={p.protocol === 'udp' ? 'warning' : 'default'}>{p.protocol.toUpperCase()}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {p.appUrn.split(':')[0]} · {p.label}
                  </div>
                </div>
              </div>
            ))}
            {showUntracked &&
              ports.untracked.map((u) => (
                <div
                  key={`m-untracked-${u.port}`}
                  className="rounded-lg border border-yellow-200 dark:border-yellow-800 p-3 flex items-center gap-3 bg-yellow-50/50 dark:bg-yellow-900/10"
                >
                  <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{u.port}</span>
                      <Badge variant="warning">untracked</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{u.process}</div>
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </section>
  );
};

// ─── Main Container ──────────────────────────────────────────────────────────

export const SystemInspectorContainer = () => {
  const { data, isLoading, refetch, isFetching, dataUpdatedAt } = useQuery<InspectionData>({
    queryKey: ['system-inspector'],
    queryFn: async () => {
      const res = await apiFetch('/api/system-inspector', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch system inspection');
      return res.json();
    },
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>Loading system inspection...</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Server className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>Unable to load system information</p>
      </div>
    );
  }

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : '';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Real-time overview of containers, ports, and system resources</p>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">Updated {lastUpdated}</span>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {data.health.hostResources && <HostResourcesSection hostResources={data.health.hostResources} />}
      <SystemHealthSection health={data.health} />
      <ContainersSection containers={data.containers} />
      <PortManagementSection ports={data.ports} />
    </div>
  );
};
