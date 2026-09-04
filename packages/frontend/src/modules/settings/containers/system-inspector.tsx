import { useAppContext } from '@/context/app-context';
import { getFullInspectionOptions } from '@/api-client/@tanstack/react-query.gen';
import { POLLING } from '@/lib/polling-budget';
import { copyToClipboard } from '@/lib/copy-to-clipboard';
import { canOpenFolderInFileExplorer, openPathInFileExplorer } from '@/lib/helpers/open-folder';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Cpu,
  Copy,
  FolderOpen,
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
import { useTranslation } from 'react-i18next';

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
  const barColor = percent > 90 ? 'bg-red-500' : percent > 70 ? 'bg-warning' : 'bg-primary';
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
  if (state === 'running') return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (state === 'exited') return <XCircle className="h-4 w-4 text-red-500" />;
  return <AlertTriangle className="h-4 w-4 text-warning" />;
};

const Badge = ({ children, variant = 'default' }: { children: React.ReactNode; variant?: 'default' | 'success' | 'danger' | 'warning' }) => {
  const colors = {
    default: 'bg-muted text-muted-foreground',
    success: 'bg-success/10 text-success',
    danger: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    warning: 'bg-warning/10 text-warning',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${colors[variant]}`}>{children}</span>;
};

const HostResourcesSection = ({ hostResources }: { hostResources: NonNullable<SystemHealth['hostResources']> }) => {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border border-border bg-linear-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-3 mb-5">
        <Server className="h-6 w-6 text-primary" />
        <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">{t('SYSTEM_INSPECTOR_HOST_CONTAINER_RESOURCES')}</h2>
        {hostResources.hasVmWedge && <Badge variant="warning">{t('SYSTEM_INSPECTOR_VM_WEDGE_DETECTED')}</Badge>}
      </div>

      <div className="rounded-md border border-border bg-muted/30 p-4 mb-4">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-2">
          {t('SYSTEM_INSPECTOR_DOCKER_RESOURCE_LIMITS')}
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{hostResources.platformGuidance}</p>
        {hostResources.recommendedDockerRamMb && (
          <p className="text-sm font-medium mt-2">
            {t('SYSTEM_INSPECTOR_RECOMMENDED_DOCKER_MEMORY')}: {Math.round(hostResources.recommendedDockerRamMb / 1024)} GB
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 border-t border-border pt-5">
        <div className="rounded-md border border-border p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-2">{t('SYSTEM_INSPECTOR_PHYSICAL_HOST')}</div>
          <div className="text-sm">
            {t('COMMON_MEMORY')}: {hostResources.hostMemoryUsedGb} / {hostResources.hostMemoryTotalGb} GB
          </div>
          <div className="text-sm">
            {t('COMMON_DISK')}: {hostResources.hostDiskUsedGb} / {hostResources.hostDiskTotalGb} GB
          </div>
        </div>
        {hostResources.hasVmWedge && (
          <div className="rounded-md border border-border p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-2">
              {t('SYSTEM_INSPECTOR_DOCKER_VM_ALLOCATED')}
            </div>
            <div className="text-sm">
              {t('COMMON_MEMORY')}: {hostResources.containerMemoryUsedGb ?? '—'} / {hostResources.containerMemoryTotalGb ?? '—'} GB
            </div>
            <div className="text-sm">
              {t('COMMON_DISK')}: {hostResources.containerDiskUsedGb ?? '—'} / {hostResources.containerDiskTotalGb ?? '—'} GB
            </div>
            {hostResources.recommendedDockerRamMb && (
              <div className="text-xs text-muted-foreground mt-2">
                {t('SYSTEM_INSPECTOR_RECOMMENDED_DOCKER_MEMORY')}: {Math.round(hostResources.recommendedDockerRamMb / 1024)} GB
              </div>
            )}
          </div>
        )}
      </div>

      {hostResources.tuningNotes && (
        <div className="mt-4 rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground border-t-0">
          <span className="font-medium text-foreground">{t('SYSTEM_INSPECTOR_AUTO_DOCKER_MEMORY_TUNING')}: </span>
          {hostResources.tuningNotes}
        </div>
      )}
    </section>
  );
};

// ─── System Health Section ───────────────────────────────────────────────────

const SystemHealthSection = ({ health }: { health: SystemHealth }) => {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border border-border bg-linear-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-3 mb-5">
        <Activity className="h-6 w-6 text-primary" />
        <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">{t('SYSTEM_INSPECTOR_SYSTEM_HEALTH')}</h2>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-5 border-t border-border pt-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Cpu}
          title={t('COMMON_CPU')}
          value={`${health.cpu.load}%`}
          subtitle={`${health.cpu.cores} ${t('COMMON_CORES')}`}
          percent={health.cpu.load}
        />
        <StatCard
          icon={MemoryStick}
          title={t('COMMON_MEMORY')}
          value={`${health.memory.percent}%`}
          subtitle={`${formatBytes(health.memory.used)} / ${formatBytes(health.memory.total)}`}
          percent={health.memory.percent}
        />
        <StatCard
          icon={HardDrive}
          title={t('COMMON_DISK')}
          value={`${health.disk.percent}%`}
          subtitle={`${formatBytes(health.disk.used * 1024 * 1024 * 1024)} / ${formatBytes(health.disk.total * 1024 * 1024 * 1024)}`}
          percent={health.disk.percent}
        />
        <StatCard icon={Clock} title={t('SYSTEM_INSPECTOR_UPTIME')} value={formatUptime(health.uptime)} subtitle={health.platform} />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-5 sm:grid-cols-4 text-sm">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-0.5">{t('COMMON_HOSTNAME')}</div>
          <div className="text-xs truncate font-medium" title={health.hostname}>
            {health.hostname}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-0.5">{t('SYSTEM_INSPECTOR_DOCKER')}</div>
          <div className="font-mono text-xs">{health.dockerVersion || t('COMMON_NOT_AVAILABLE_SHORT')}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-0.5">{t('SYSTEM_INSPECTOR_CONTAINERS')}</div>
          <div className="flex gap-1.5 items-center flex-wrap">
            <Badge variant="success">
              {health.containerCount.running} {t('SYSTEM_INSPECTOR_RUNNING')}
            </Badge>
            {health.containerCount.stopped > 0 && (
              <Badge variant="danger">
                {health.containerCount.stopped} {t('SYSTEM_INSPECTOR_STOPPED')}
              </Badge>
            )}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-0.5">{t('SYSTEM_INSPECTOR_CPU_MODEL')}</div>
          <div className="text-xs truncate font-medium" title={health.cpu.model}>
            {health.cpu.model}
          </div>
        </div>
      </div>
    </section>
  );
};

// ─── Containers Section ─────────────────────────────────────────────────────

const ContainersSection = ({ containers }: { containers: ContainerInfo[] }) => {
  const { t } = useTranslation();
  const running = containers.filter((c) => c.state === 'running');
  const stopped = containers.filter((c) => c.state !== 'running');
  const sorted = [...running, ...stopped];

  return (
    <section className="rounded-lg border border-border bg-linear-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-3 mb-5">
        <Container className="h-6 w-6 text-primary shrink-0" />
        <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">{t('SYSTEM_INSPECTOR_DOCKER_CONTAINERS')}</h2>
        <Badge>
          {containers.length} {t('SYSTEM_INSPECTOR_TOTAL')}
        </Badge>
      </div>

      {sorted.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-md border border-dashed p-4 text-center">{t('SYSTEM_INSPECTOR_NO_CONTAINERS')}</div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-2 pl-3 font-medium text-muted-foreground">{t('COMMON_STATUS')}</th>
                  <th className="text-left p-2 font-medium text-muted-foreground">{t('SYSTEM_INSPECTOR_CONTAINER')}</th>
                  <th className="text-left p-2 font-medium text-muted-foreground hidden md:table-cell">{t('COMMON_IMAGE')}</th>
                  <th className="text-left p-2 font-medium text-muted-foreground hidden sm:table-cell">{t('COMMON_PORTS')}</th>
                  <th className="text-left p-2 font-medium text-muted-foreground hidden sm:table-cell">{t('SYSTEM_INSPECTOR_UPTIME')}</th>
                  <th className="text-left p-2 pr-3 font-medium text-muted-foreground hidden lg:table-cell">{t('SYSTEM_INSPECTOR_APP')}</th>
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
                        {c.ports.filter((p) => p.hostPort).length === 0 && <span className="text-xs text-muted-foreground">{t('COMMON_DASH')}</span>}
                      </div>
                    </td>
                    <td className="p-2 hidden sm:table-cell">
                      <span className="text-xs text-muted-foreground">{c.uptime}</span>
                    </td>
                    <td className="p-2 pr-3 hidden lg:table-cell">
                      {c.appUrn ? (
                        <Badge variant="default">{c.appUrn.split(':')[0]}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('SYSTEM_INSPECTOR_SYSTEM')}</span>
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
  const { t } = useTranslation();
  const [showUntracked, setShowUntracked] = useState(true);

  return (
    <section className="rounded-lg border border-border bg-linear-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <Network className="h-6 w-6 text-primary shrink-0" />
        <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">{t('SYSTEM_INSPECTOR_PORT_ALLOCATIONS')}</h2>
        <Badge>
          {ports.allocations.length} {t('SYSTEM_INSPECTOR_MANAGED')}
        </Badge>
        {ports.untracked.length > 0 && (
          <button type="button" onClick={() => setShowUntracked(!showUntracked)} className="ml-auto">
            <Badge variant="warning">
              {ports.untracked.length} {t('SYSTEM_INSPECTOR_UNTRACKED')}
            </Badge>
          </button>
        )}
      </div>

      {ports.allocations.length === 0 && ports.untracked.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-md border border-dashed p-4 text-center">
          {t('SYSTEM_INSPECTOR_NO_PORT_ALLOCATIONS')}
        </div>
      ) : (
        <>
          {/* Desktop: Table */}
          <div className="rounded-lg border overflow-hidden hidden sm:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-2 pl-3 font-medium text-muted-foreground">{t('COMMON_STATUS')}</th>
                    <th className="text-left p-2 font-medium text-muted-foreground">{t('COMMON_HOST_PORT')}</th>
                    <th className="text-left p-2 font-medium text-muted-foreground">{t('SYSTEM_INSPECTOR_TO_CONTAINER')}</th>
                    <th className="text-left p-2 font-medium text-muted-foreground">{t('SYSTEM_INSPECTOR_PROTOCOL')}</th>
                    <th className="text-left p-2 font-medium text-muted-foreground">{t('SYSTEM_INSPECTOR_LABEL')}</th>
                    <th className="text-left p-2 font-medium text-muted-foreground">{t('SYSTEM_INSPECTOR_APP')}</th>
                    <th className="text-left p-2 pr-3 font-medium text-muted-foreground hidden md:table-cell">{t('SYSTEM_INSPECTOR_CONTAINER')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ports.allocations.map((p) => (
                    <tr key={`${p.hostPort}-${p.protocol}`} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="p-2 pl-3">
                        {p.bound ? (
                          <span title={t('SYSTEM_INSPECTOR_PORT_BOUND_ACTIVE')}>
                            <CheckCircle2 className="h-4 w-4 text-success" />
                          </span>
                        ) : (
                          <span title={t('SYSTEM_INSPECTOR_PORT_ALLOCATED_NOT_BOUND')}>
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
                      <tr key={`untracked-${u.port}`} className="border-b last:border-0 bg-warning/10 hover:bg-warning/15 transition-colors">
                        <td className="p-2 pl-3">
                          <span title={t('SYSTEM_INSPECTOR_UNTRACKED_PORT')}>
                            <AlertTriangle className="h-4 w-4 text-warning" />
                          </span>
                        </td>
                        <td className="p-2 font-mono text-xs font-semibold">{u.port}</td>
                        <td className="p-2 font-mono text-xs text-muted-foreground">-</td>
                        <td className="p-2">
                          <Badge variant="warning">?</Badge>
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">{t('SYSTEM_INSPECTOR_UNTRACKED')}</td>
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
                  <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
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
                <div key={`m-untracked-${u.port}`} className="rounded-lg border border-warning/30 p-3 flex items-center gap-3 bg-warning/10">
                  <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{u.port}</span>
                      <Badge variant="warning">{t('SYSTEM_INSPECTOR_UNTRACKED')}</Badge>
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

// ─── Storage Section ─────────────────────────────────────────────────────────

/**
 * Shows the root app-data folder (parent of every app's persistent data).
 * Desktop Tauri opens it in the OS file manager; a browser or phone copies
 * the host path instead — those clients are not the Hub machine.
 */
const StorageSection = ({ appDataRootHostPath }: { appDataRootHostPath: string }) => {
  const { t } = useTranslation();
  const canOpen = canOpenFolderInFileExplorer();

  return (
    <section className="rounded-lg border border-border bg-linear-to-b from-card to-card/60 p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-3 mb-5">
        <HardDrive className="h-6 w-6 text-primary" />
        <h2 className="text-base font-bold uppercase tracking-wide sm:text-lg">{t('SYSTEM_INSPECTOR_STORAGE')}</h2>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t('SETTINGS_OPEN_APP_DATA_FOLDER')}</div>
          <div className="text-xs text-muted-foreground break-all" title={appDataRootHostPath}>
            {appDataRootHostPath}
          </div>
        </div>
        {canOpen ? (
          <button
            type="button"
            onClick={() => openPathInFileExplorer(appDataRootHostPath)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
            data-testid="open-app-data-folder-btn"
          >
            <FolderOpen className="h-4 w-4" />
            {t('SETTINGS_OPEN_APP_DATA_FOLDER')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => copyToClipboard(appDataRootHostPath, t('APP_ACTION_DATA_FOLDER_PATH_COPIED'))}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
            data-testid="copy-app-data-folder-btn"
          >
            <Copy className="h-4 w-4" />
            {t('SETTINGS_COPY_APP_DATA_FOLDER')}
          </button>
        )}
      </div>
    </section>
  );
};

// ─── Main Container ──────────────────────────────────────────────────────────

export const SystemInspectorContainer = () => {
  const { t } = useTranslation();
  const { appDataRootHostPath } = useAppContext();
  const { data, isLoading, refetch, isFetching, dataUpdatedAt } = useQuery({
    ...getFullInspectionOptions(),
    select: (payload) => payload as InspectionData,
    refetchInterval: POLLING.SYSTEM_INSPECTOR_MS,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>{t('SYSTEM_INSPECTOR_LOADING')}</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Server className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>{t('SYSTEM_INSPECTOR_UNABLE_TO_LOAD')}</p>
      </div>
    );
  }

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : '';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('SYSTEM_INSPECTOR_REALTIME_OVERVIEW')}</p>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">
            {t('COMMON_UPDATED')} {lastUpdated}
          </span>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            {t('COMMON_REFRESH')}
          </button>
        </div>
      </div>

      {appDataRootHostPath && <StorageSection appDataRootHostPath={appDataRootHostPath} />}
      {data.health.hostResources && <HostResourcesSection hostResources={data.health.hostResources} />}
      <SystemHealthSection health={data.health} />
      <ContainersSection containers={data.containers} />
      <PortManagementSection ports={data.ports} />
    </div>
  );
};
