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

const ProgressBar = ({ percent, color = 'primary' }: { percent: number; color?: string }) => {
  const barColor =
    percent > 90
      ? 'bg-red-500'
      : percent > 70
        ? 'bg-yellow-500'
        : color === 'primary'
          ? 'bg-primary'
          : color === 'green'
            ? 'bg-green-500'
            : 'bg-blue-500';

  return (
    <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
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
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string;
  subtitle?: string;
  percent?: number;
  color?: string;
}) => (
  <div className="rounded-lg border p-4 flex flex-col gap-2">
    <div className="flex items-center gap-2 text-muted-foreground">
      <Icon className="h-4 w-4" />
      <span className="text-xs font-medium uppercase tracking-wider">{title}</span>
    </div>
    <div className="text-2xl font-bold">{value}</div>
    {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
    {percent !== undefined && <ProgressBar percent={percent} color={color} />}
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

// ─── System Health Section ───────────────────────────────────────────────────

const SystemHealthSection = ({ health }: { health: SystemHealth }) => (
  <div className="flex flex-col gap-4">
    <div className="flex items-center gap-2">
      <Activity className="h-5 w-5 text-primary" />
      <h3 className="text-base font-semibold">System Health</h3>
    </div>

    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
        subtitle={`${health.disk.used} GB / ${health.disk.total} GB`}
        percent={health.disk.percent}
      />
      <StatCard icon={Clock} title="Uptime" value={formatUptime(health.uptime)} subtitle={health.platform} />
    </div>

    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <div className="rounded-lg border p-3">
        <div className="text-xs text-muted-foreground mb-1">Hostname</div>
        <div className="font-mono text-xs break-all">{health.hostname}</div>
      </div>
      <div className="rounded-lg border p-3">
        <div className="text-xs text-muted-foreground mb-1">Docker</div>
        <div className="font-mono text-xs">{health.dockerVersion || 'N/A'}</div>
      </div>
      <div className="rounded-lg border p-3">
        <div className="text-xs text-muted-foreground mb-1">Containers</div>
        <div className="flex gap-2 items-center">
          <Badge variant="success">{health.containerCount.running} running</Badge>
          {health.containerCount.stopped > 0 && <Badge variant="danger">{health.containerCount.stopped} stopped</Badge>}
        </div>
      </div>
      <div className="rounded-lg border p-3">
        <div className="text-xs text-muted-foreground mb-1">CPU Model</div>
        <div className="text-xs truncate" title={health.cpu.model}>
          {health.cpu.model}
        </div>
      </div>
    </div>
  </div>
);

// ─── Containers Section ─────────────────────────────────────────────────────

const ContainersSection = ({ containers }: { containers: ContainerInfo[] }) => {
  const running = containers.filter((c) => c.state === 'running');
  const stopped = containers.filter((c) => c.state !== 'running');
  const sorted = [...running, ...stopped];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Container className="h-5 w-5 text-primary" />
        <h3 className="text-base font-semibold">Docker Containers</h3>
        <Badge>{containers.length} total</Badge>
      </div>

      {sorted.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-lg border border-dashed p-4 text-center">No containers found</div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-2 pl-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Container</th>
                  <th className="text-left p-2 font-medium text-muted-foreground hidden md:table-cell">Image</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Ports</th>
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
                    <td className="p-2">
                      <div className="font-mono text-xs">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{c.id}</div>
                    </td>
                    <td className="p-2 hidden md:table-cell">
                      <div className="font-mono text-xs truncate max-w-[200px]" title={c.image}>
                        {c.image.split('/').pop()?.split(':')[0] || c.image}
                      </div>
                    </td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1">
                        {c.ports
                          .filter((p) => p.hostPort)
                          .map((p, _i) => (
                            <Badge key={`${p.hostPort}-${p.containerPort}-${p.protocol}`} variant={c.state === 'running' ? 'success' : 'default'}>
                              {p.hostPort}→{p.containerPort}/{p.protocol}
                            </Badge>
                          ))}
                        {c.ports.filter((p) => p.hostPort).length === 0 && <span className="text-xs text-muted-foreground">none</span>}
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
    </div>
  );
};

// ─── Port Management Section ─────────────────────────────────────────────────

const PortManagementSection = ({ ports }: { ports: { allocations: PortStatus[]; untracked: Array<{ port: number; process: string }> } }) => {
  const [showUntracked, setShowUntracked] = useState(true);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Network className="h-5 w-5 text-primary" />
        <h3 className="text-base font-semibold">Port Allocations</h3>
        <Badge>{ports.allocations.length} managed</Badge>
        {ports.untracked.length > 0 && (
          <button type="button" onClick={() => setShowUntracked(!showUntracked)} className="ml-auto">
            <Badge variant="warning">{ports.untracked.length} untracked</Badge>
          </button>
        )}
      </div>

      {ports.allocations.length === 0 && ports.untracked.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-lg border border-dashed p-4 text-center">
          No port allocations yet. Install an app to see port assignments here.
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-2 pl-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Host Port</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">→ Container</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Protocol</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">Label</th>
                  <th className="text-left p-2 font-medium text-muted-foreground hidden sm:table-cell">App</th>
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
                    <td className="p-2 hidden sm:table-cell">
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
                      <td className="p-2 hidden sm:table-cell text-xs text-muted-foreground">-</td>
                      <td className="p-2 pr-3 hidden md:table-cell font-mono text-xs">{u.process}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main Container ──────────────────────────────────────────────────────────

export const SystemInspectorContainer = () => {
  const { data, isLoading, refetch, isFetching, dataUpdatedAt } = useQuery<InspectionData>({
    queryKey: ['system-inspector'],
    queryFn: async () => {
      const res = await fetch('/api/system-inspector', { credentials: 'include' });
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
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">System Inspector</h3>
          <p className="text-sm text-muted-foreground">Real-time overview of containers, ports, and system resources</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Updated {lastUpdated}</span>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      <SystemHealthSection health={data.health} />
      <ContainersSection containers={data.containers} />
      <PortManagementSection ports={data.ports} />
    </div>
  );
};
