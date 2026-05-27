import { createAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { PortManagerService } from '@/modules/network/port-manager.service';
import { Injectable } from '@nestjs/common';
import si from 'systeminformation';
import Dockerode from 'dockerode';
import { Inject } from '@nestjs/common';
import { DOCKERODE } from '@/modules/docker/docker.module';
import net from 'node:net';
import os from 'node:os';

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

type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low';
type SecurityExposure = 'cloudflare' | 'tailscale' | 'local' | 'host';

interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  category: 'credentials' | 'exposure' | 'runtime' | 'network' | 'supply-chain';
  title: string;
  description: string;
  remediation: string;
  appUrn?: string;
  appName?: string;
  exposure: SecurityExposure;
  scoreImpact: number;
}

interface SecurityDigestSummary {
  score: number;
  findings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  cloudflareExposedApps: number;
  tailscaleExposedApps: number;
  localApps: number;
}

interface SecurityAppDigest {
  appUrn: string;
  appName: string;
  status: string;
  exposure: SecurityExposure;
  sensitivity: 'high' | 'medium' | 'standard';
  score: number;
  findings: number;
  topFinding?: string;
}

interface SecurityDigest {
  summary: SecurityDigestSummary;
  overview: string;
  findings: SecurityFinding[];
  apps: SecurityAppDigest[];
}

interface ContainerSecurityDetails {
  image: string;
  privileged: boolean;
  runsAsRoot: boolean;
  dangerousCapabilities: string[];
  sensitiveMounts: string[];
  dockerSocketMounted: boolean;
  hostNetwork: boolean;
}

const DANGEROUS_CAPABILITIES = new Set(['ALL', 'SYS_ADMIN', 'NET_ADMIN', 'SYS_MODULE', 'SYS_PTRACE', 'DAC_READ_SEARCH']);
const WEAK_PASSWORD_VALUES = new Set([
  'admin',
  'admin123',
  'changeme',
  'change-me',
  'default',
  'password',
  'password123',
  'qwerty',
  'root',
  'test',
  'toor',
  'welcome',
  '123456',
  '12345678',
]);
const WEAK_USERNAME_VALUES = new Set(['admin', 'administrator', 'root', 'test', 'user']);
const SENSITIVE_APP_KEYWORDS = [
  'admin',
  'auth',
  'backup',
  'bitwarden',
  'code',
  'database',
  'db',
  'gitea',
  'gitlab',
  'identity',
  'keycloak',
  'ldap',
  'mariadb',
  'mongo',
  'mysql',
  'n8n',
  'password',
  'portainer',
  'postgres',
  'proxy',
  'redis',
  'repo',
  'secret',
  'ssh',
  'traefik',
  'vault',
  'vaultwarden',
];
const MEDIUM_SENSITIVITY_KEYWORDS = ['calendar', 'chat', 'cloud', 'docs', 'drive', 'files', 'mail', 'media', 'notes', 'photos', 'storage', 'wiki'];
const SENSITIVE_HOST_PATH_PREFIXES = ['/etc', '/proc', '/root', '/sys', '/var/lib/docker'];
const SEVERITY_WEIGHT: Record<SecuritySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

@Injectable()
export class SystemInspectorService {
  constructor(
    private readonly logger: LoggerService,
    private readonly portManager: PortManagerService,
    private readonly appsRepository: AppsRepository,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {}

  async getFullInspection() {
    const [containers, ports, health, security] = await Promise.all([
      this.getContainers(),
      this.getPortStatus(),
      this.getSystemHealth(),
      this.getSecurityDigest(),
    ]);
    return { containers, ports, health, security, timestamp: new Date().toISOString() };
  }

  async getSecurityDigest(): Promise<SecurityDigest> {
    const [apps, dockerContainers, ports] = await Promise.all([
      this.appsRepository.getApps().catch((err) => {
        this.logger.error(`Failed to load installed apps for security digest: ${err}`);
        return [];
      }),
      this.docker.listContainers({ all: true }).catch((err) => {
        this.logger.error(`Failed to list containers for security digest: ${err}`);
        return [];
      }),
      this.getPortStatus(),
    ]);

    const containersByAppUrn = new Map<string, Dockerode.ContainerInfo[]>();
    for (const container of dockerContainers) {
      const appUrn = container.Labels?.['ci-os-hub.appurn'];
      if (!appUrn) continue;
      const existing = containersByAppUrn.get(appUrn) ?? [];
      existing.push(container);
      containersByAppUrn.set(appUrn, existing);
    }

    const findings: SecurityFinding[] = [];
    const appDigests: SecurityAppDigest[] = [];

    for (const installedApp of apps) {
      const appUrn = createAppUrn(installedApp.appName, installedApp.appStoreSlug);
      const exposure = this.normalizeExposure(installedApp.exposureMode);
      const sensitivity = this.classifySensitivity(installedApp.appName, installedApp.config);
      const appFindings: SecurityFinding[] = [];
      const weakCredentials = this.findWeakCredentialSignals(installedApp.config);
      const matchingContainers = containersByAppUrn.get(appUrn) ?? [];
      const posture = await this.getAggregatedContainerSecurity(matchingContainers);

      if (weakCredentials.length > 0) {
        appFindings.push({
          id: `${appUrn}-weak-credentials`,
          severity: exposure === 'cloudflare' ? 'critical' : exposure === 'tailscale' ? 'high' : 'medium',
          category: 'credentials',
          title: `${installedApp.appName} appears to use weak or default credentials`,
          description: `${installedApp.appName} has weak credential values in its saved configuration (${weakCredentials.join(', ')}). Because this app is ${this.describeExposure(
            exposure,
          )}, the risk is contextual to how reachable it is right now.`,
          remediation:
            exposure === 'cloudflare'
              ? 'Rotate the affected credentials immediately and consider restricting the app to Tailscale-only access until they are changed.'
              : 'Rotate the affected credentials and review who can currently reach the app.',
          appUrn,
          appName: installedApp.appName,
          exposure,
          scoreImpact: exposure === 'cloudflare' ? 35 : exposure === 'tailscale' ? 24 : 16,
        });
      }

      if (exposure === 'cloudflare' && sensitivity === 'high') {
        appFindings.push({
          id: `${appUrn}-internet-sensitive`,
          severity: 'high',
          category: 'exposure',
          title: `${installedApp.appName} is internet-facing`,
          description: `${installedApp.appName} looks like a higher-sensitivity app, but it is currently exposed through Cloudflare. That increases the blast radius if credentials are weak or a future vulnerability appears.`,
          remediation: 'If the app does not need public internet access, switch it to Tailscale-only or local-only exposure in Settings → Network.',
          appUrn,
          appName: installedApp.appName,
          exposure,
          scoreImpact: 18,
        });
      }

      if (posture.privileged) {
        appFindings.push({
          id: `${appUrn}-privileged`,
          severity: exposure === 'cloudflare' ? 'high' : 'medium',
          category: 'runtime',
          title: `${installedApp.appName} is running in privileged mode`,
          description:
            'Privileged containers get broad access to the host kernel and devices. That makes a container escape or app compromise far more damaging on this Hub.',
          remediation: 'Disable privileged mode unless the app explicitly requires it, or isolate this workload from internet exposure.',
          appUrn,
          appName: installedApp.appName,
          exposure,
          scoreImpact: exposure === 'cloudflare' ? 20 : 12,
        });
      }

      if (posture.dockerSocketMounted) {
        appFindings.push({
          id: `${appUrn}-docker-socket`,
          severity: 'high',
          category: 'runtime',
          title: `${installedApp.appName} can control the Docker host`,
          description: 'This app has the Docker socket mounted, which effectively gives it control over other containers and the host runtime.',
          remediation: 'Remove the Docker socket mount if it is not strictly necessary, or treat this app as highly trusted infrastructure.',
          appUrn,
          appName: installedApp.appName,
          exposure,
          scoreImpact: 22,
        });
      }

      if (posture.sensitiveMounts.length > 0) {
        appFindings.push({
          id: `${appUrn}-sensitive-mounts`,
          severity: 'high',
          category: 'runtime',
          title: `${installedApp.appName} can write to sensitive host paths`,
          description: `${installedApp.appName} mounts sensitive host paths (${posture.sensitiveMounts.join(', ')}). If the app is compromised, those files become part of the attack surface.`,
          remediation: 'Replace broad host mounts with the smallest possible app-specific volume.',
          appUrn,
          appName: installedApp.appName,
          exposure,
          scoreImpact: 18,
        });
      }

      if (posture.hostNetwork) {
        appFindings.push({
          id: `${appUrn}-host-network`,
          severity: 'medium',
          category: 'runtime',
          title: `${installedApp.appName} uses host networking`,
          description: 'Host networking bypasses normal container network isolation and can make exposure harder to reason about.',
          remediation: 'Use explicit published ports or a reverse proxy unless host networking is required.',
          appUrn,
          appName: installedApp.appName,
          exposure,
          scoreImpact: 10,
        });
      }

      if (posture.dangerousCapabilities.length > 0) {
        appFindings.push({
          id: `${appUrn}-capabilities`,
          severity: 'medium',
          category: 'runtime',
          title: `${installedApp.appName} requests elevated Linux capabilities`,
          description: `${installedApp.appName} adds ${posture.dangerousCapabilities.join(', ')}. These capabilities increase what the container can do on the host.`,
          remediation: 'Drop any unnecessary capabilities and keep only the minimum set required by the app.',
          appUrn,
          appName: installedApp.appName,
          exposure,
          scoreImpact: 10,
        });
      }

      if (matchingContainers.length > 0 && posture.runsAsRoot) {
        appFindings.push({
          id: `${appUrn}-runs-as-root`,
          severity: 'medium',
          category: 'runtime',
          title: `${installedApp.appName} is running as root`,
          description:
            'Running the container as root increases the impact of an app compromise, especially when combined with extra mounts or capabilities.',
          remediation: 'Prefer a non-root container user when the image supports it.',
          appUrn,
          appName: installedApp.appName,
          exposure,
          scoreImpact: 8,
        });
      }

      const unpinnedImages = this.getUnpinnedImages(matchingContainers, posture.image);
      if (unpinnedImages.length > 0) {
        appFindings.push({
          id: `${appUrn}-unpinned-image`,
          severity: exposure === 'cloudflare' ? 'medium' : 'low',
          category: 'supply-chain',
          title: `${installedApp.appName} uses a floating image tag`,
          description: `${installedApp.appName} is running ${unpinnedImages.join(', ')}, which makes it harder to tell exactly which image build is deployed on this Hub.`,
          remediation: 'Prefer a version-pinned image tag or digest so updates are intentional and auditable.',
          appUrn,
          appName: installedApp.appName,
          exposure,
          scoreImpact: exposure === 'cloudflare' ? 8 : 4,
        });
      }

      appFindings.sort((a, b) => SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity] || b.scoreImpact - a.scoreImpact);
      findings.push(...appFindings);

      const appScore = Math.max(0, 100 - appFindings.reduce((sum, finding) => sum + finding.scoreImpact, 0));
      appDigests.push({
        appUrn,
        appName: installedApp.appName,
        status: installedApp.status,
        exposure,
        sensitivity,
        score: appScore,
        findings: appFindings.length,
        topFinding: appFindings[0]?.title,
      });
    }

    if (ports.untracked.length > 0) {
      findings.push({
        id: 'untracked-host-ports',
        severity: ports.untracked.length > 3 ? 'high' : 'medium',
        category: 'network',
        title: 'Host ports are bound outside Hub tracking',
        description: `${ports.untracked.length} bound port(s) are active on the host but are not represented in the Hub allocation table (${ports.untracked
          .slice(0, 4)
          .map((entry) => `${entry.port}:${entry.process}`)
          .join(', ')}).`,
        remediation: 'Review those processes and either bring them under Hub management or close the ports you do not need.',
        exposure: 'host',
        scoreImpact: ports.untracked.length > 3 ? 16 : 10,
      });
    }

    findings.sort((a, b) => SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity] || b.scoreImpact - a.scoreImpact);
    appDigests.sort((a, b) => a.score - b.score || a.appName.localeCompare(b.appName));

    const summary: SecurityDigestSummary = {
      score: Math.max(0, 100 - findings.reduce((sum, finding) => sum + finding.scoreImpact, 0)),
      findings: findings.length,
      critical: findings.filter((finding) => finding.severity === 'critical').length,
      high: findings.filter((finding) => finding.severity === 'high').length,
      medium: findings.filter((finding) => finding.severity === 'medium').length,
      low: findings.filter((finding) => finding.severity === 'low').length,
      cloudflareExposedApps: apps.filter((app) => this.normalizeExposure(app.exposureMode) === 'cloudflare').length,
      tailscaleExposedApps: apps.filter((app) => this.normalizeExposure(app.exposureMode) === 'tailscale').length,
      localApps: apps.filter((app) => this.normalizeExposure(app.exposureMode) === 'local').length,
    };

    return {
      summary,
      overview: this.buildSecurityOverview(summary),
      findings,
      apps: appDigests,
    };
  }

  async getContainers(): Promise<ContainerInfo[]> {
    try {
      const containers = await this.docker.listContainers({ all: true });
      return containers.map((c) => {
        const names = c.Names?.map((n) => n.replace(/^\//, '')) || [];
        const appUrn = c.Labels?.['ci-os-hub.appurn'] || null;
        const ports = (c.Ports || []).map((p) => ({
          hostPort: p.PublicPort || null,
          containerPort: p.PrivatePort,
          protocol: p.Type || 'tcp',
        }));

        const created = c.Created || 0;
        const uptimeMs = Date.now() - created * 1000;
        const uptime = this.formatUptime(uptimeMs);

        return {
          id: c.Id?.substring(0, 12) || '',
          name: names[0] || c.Id?.substring(0, 12) || 'unknown',
          image: c.Image || '',
          state: c.State || 'unknown',
          status: c.Status || '',
          ports,
          appUrn,
          created,
          uptime: c.State === 'running' ? uptime : '-',
        };
      });
    } catch (err) {
      this.logger.error(`Failed to list containers: ${err}`);
      return [];
    }
  }

  async getPortStatus(): Promise<{ allocations: PortStatus[]; untracked: Array<{ port: number; process: string }> }> {
    try {
      const allocations = await this.portManager.getAllAllocations();
      const containers = await this.getContainers();

      // Build a map of host port → container info
      const portToContainer = new Map<number, { name: string; state: string }>();
      for (const container of containers) {
        for (const p of container.ports) {
          if (p.hostPort) {
            portToContainer.set(p.hostPort, { name: container.name, state: container.state });
          }
        }
      }

      const portStatuses: PortStatus[] = await Promise.all(
        allocations.map(async (alloc) => {
          const containerInfo = portToContainer.get(alloc.hostPort);
          let bound = false;
          if (containerInfo) {
            bound = containerInfo.state === 'running';
          } else {
            bound = await this.isPortBound(alloc.hostPort);
          }

          return {
            hostPort: alloc.hostPort,
            containerPort: alloc.containerPort,
            protocol: alloc.protocol,
            label: alloc.label,
            appUrn: alloc.appUrn,
            bound,
            containerName: containerInfo?.name || null,
            containerState: containerInfo?.state || null,
          };
        }),
      );

      // Find untracked ports (bound on host but not in our allocation table)
      const trackedPorts = new Set(allocations.map((a) => a.hostPort));
      const untrackedPorts: Array<{ port: number; process: string }> = [];
      for (const [port, info] of portToContainer) {
        if (!trackedPorts.has(port)) {
          untrackedPorts.push({ port, process: info.name });
        }
      }

      return { allocations: portStatuses, untracked: untrackedPorts };
    } catch (err) {
      this.logger.error(`Failed to get port status: ${err}`);
      return { allocations: [], untracked: [] };
    }
  }

  async getSystemHealth(): Promise<SystemHealth> {
    try {
      const [cpuLoad, cpuInfo, mem, disk, dockerInfo] = await Promise.all([
        si.currentLoad(),
        si.cpu(),
        this.getMemoryInfo(),
        si.fsSize(),
        this.getDockerInfo(),
      ]);

      const disk0 = disk[0] ?? { available: 0, size: 0, used: 0 };

      return {
        cpu: {
          load: Math.round(cpuLoad.currentLoad * 10) / 10,
          cores: cpuInfo.cores,
          model: `${cpuInfo.manufacturer} ${cpuInfo.brand}`,
        },
        memory: {
          total: mem.total,
          used: mem.used,
          free: mem.available,
          percent: mem.total > 0 ? Math.round(((mem.total - mem.available) / mem.total) * 100) : 0,
        },
        disk: {
          total: Math.round(disk0.size / 1024 / 1024 / 1024),
          used: Math.round((disk0.size - disk0.available) / 1024 / 1024 / 1024),
          free: Math.round(disk0.available / 1024 / 1024 / 1024),
          percent: disk0.size > 0 ? Math.round(((disk0.size - disk0.available) / disk0.size) * 100) : 0,
        },
        uptime: os.uptime(),
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        hostname: os.hostname(),
        dockerVersion: dockerInfo.version,
        containerCount: dockerInfo.containers,
      };
    } catch (err) {
      this.logger.error(`Failed to get system health: ${err}`);
      return {
        cpu: { load: 0, cores: 0, model: 'unknown' },
        memory: { total: 0, used: 0, free: 0, percent: 0 },
        disk: { total: 0, used: 0, free: 0, percent: 0 },
        uptime: 0,
        platform: 'unknown',
        hostname: 'unknown',
        dockerVersion: null,
        containerCount: { running: 0, stopped: 0, total: 0 },
      };
    }
  }

  private async getMemoryInfo() {
    try {
      const mem = await si.mem();
      return { total: mem.total, used: mem.used, available: mem.available };
    } catch {
      return { total: os.totalmem(), used: os.totalmem() - os.freemem(), available: os.freemem() };
    }
  }

  private async getDockerInfo(): Promise<{ version: string | null; containers: { running: number; stopped: number; total: number } }> {
    try {
      const info = await this.docker.info();
      return {
        version: info.ServerVersion || null,
        containers: {
          running: info.ContainersRunning || 0,
          stopped: info.ContainersStopped || 0,
          total: info.Containers || 0,
        },
      };
    } catch {
      return { version: null, containers: { running: 0, stopped: 0, total: 0 } };
    }
  }

  private isPortBound(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(true));
      server.once('listening', () => {
        server.close(() => resolve(false));
      });
      server.listen(port, '0.0.0.0');
    });
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  private normalizeExposure(exposureMode?: string | null): SecurityExposure {
    if (exposureMode === 'cloudflare' || exposureMode === 'tailscale') return exposureMode;
    return 'local';
  }

  private describeExposure(exposure: SecurityExposure) {
    if (exposure === 'cloudflare') return 'reachable from the internet via Cloudflare';
    if (exposure === 'tailscale') return 'reachable to anyone on your Tailscale network';
    if (exposure === 'host') return 'reachable on the host network';
    return 'limited to your local network';
  }

  private classifySensitivity(appName: string, config: Record<string, unknown>) {
    const haystack = `${appName} ${Object.keys(config ?? {}).join(' ')}`.toLowerCase();
    if (SENSITIVE_APP_KEYWORDS.some((keyword) => haystack.includes(keyword))) return 'high' as const;
    if (MEDIUM_SENSITIVITY_KEYWORDS.some((keyword) => haystack.includes(keyword))) return 'medium' as const;
    return 'standard' as const;
  }

  private findWeakCredentialSignals(config: Record<string, unknown>) {
    const hits: string[] = [];
    const visit = (value: unknown, path: string[] = []) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        const nextPath = [...path, key];
        if (typeof entry === 'string') {
          const normalized = entry.trim().toLowerCase();
          const label = nextPath.join('.');
          if (/(pass(word)?|secret|token|key)/i.test(key) && WEAK_PASSWORD_VALUES.has(normalized)) {
            hits.push(`${label}=${entry}`);
          }
          if (/(user(name)?|login|admin)/i.test(key) && WEAK_USERNAME_VALUES.has(normalized)) {
            hits.push(`${label}=${entry}`);
          }
          continue;
        }

        if (typeof entry === 'object') {
          visit(entry, nextPath);
        }
      }
    };

    visit(config);
    const passwordHit = hits.some((hit) => /(pass(word)?|secret|token|key)=/i.test(hit));
    return passwordHit ? Array.from(new Set(hits)) : [];
  }

  private async getAggregatedContainerSecurity(containers: Dockerode.ContainerInfo[]) {
    const posture: ContainerSecurityDetails = {
      image: '',
      privileged: false,
      runsAsRoot: false,
      dangerousCapabilities: [],
      sensitiveMounts: [],
      dockerSocketMounted: false,
      hostNetwork: false,
    };

    if (containers.length === 0) {
      return posture;
    }

    const inspected = await Promise.all(containers.map((container) => this.inspectContainerSecurity(container.Id, container.Image)));

    posture.image = inspected.map((entry) => entry.image).find(Boolean) ?? containers[0]?.Image ?? '';
    posture.privileged = inspected.some((entry) => entry.privileged);
    posture.runsAsRoot = inspected.some((entry) => entry.runsAsRoot);
    posture.dockerSocketMounted = inspected.some((entry) => entry.dockerSocketMounted);
    posture.hostNetwork = inspected.some((entry) => entry.hostNetwork);
    posture.dangerousCapabilities = Array.from(new Set(inspected.flatMap((entry) => entry.dangerousCapabilities))).sort();
    posture.sensitiveMounts = Array.from(new Set(inspected.flatMap((entry) => entry.sensitiveMounts))).sort();

    return posture;
  }

  private async inspectContainerSecurity(containerId: string, image: string): Promise<ContainerSecurityDetails> {
    try {
      const details = await this.docker.getContainer(containerId).inspect();
      const configUser = details.Config?.User?.trim();
      const mounts = details.Mounts ?? [];
      const binds = details.HostConfig?.Binds ?? [];
      const capabilities = (details.HostConfig?.CapAdd ?? []).map((capability: string) => capability.toUpperCase());

      return {
        image: details.Config?.Image || image,
        privileged: Boolean(details.HostConfig?.Privileged),
        runsAsRoot: !configUser || configUser === '0' || configUser.toLowerCase() === 'root',
        dangerousCapabilities: capabilities.filter((capability: string) => DANGEROUS_CAPABILITIES.has(capability)),
        sensitiveMounts: mounts
          .map((mount) => mount.Source ?? '')
          .filter((source) => this.isSensitiveHostPath(source) && source !== '/var/run/docker.sock'),
        dockerSocketMounted:
          binds.some((bind) => bind.startsWith('/var/run/docker.sock:')) ||
          mounts.some((mount) => (mount.Source ?? '').startsWith('/var/run/docker.sock')),
        hostNetwork: details.HostConfig?.NetworkMode === 'host',
      };
    } catch (err) {
      this.logger.error(`Failed to inspect container ${containerId} for security digest: ${err}`);
      return {
        image,
        privileged: false,
        runsAsRoot: false,
        dangerousCapabilities: [],
        sensitiveMounts: [],
        dockerSocketMounted: false,
        hostNetwork: false,
      };
    }
  }

  private isSensitiveHostPath(source: string) {
    return source === '/var/run/docker.sock' || SENSITIVE_HOST_PATH_PREFIXES.some((prefix) => source === prefix || source.startsWith(`${prefix}/`));
  }

  private getUnpinnedImages(containers: Dockerode.ContainerInfo[], inspectedImage?: string) {
    const images = Array.from(
      new Set([inspectedImage, ...containers.map((container) => container.Image)].filter((image): image is string => Boolean(image))),
    );
    return images.filter((image) => !this.isPinnedImage(image));
  }

  private isPinnedImage(image: string) {
    if (!image) return true;
    if (image.includes('@sha256:')) return true;
    const imageWithoutRegistryPort = image.substring(image.lastIndexOf('/') + 1);
    const tagSeparator = imageWithoutRegistryPort.lastIndexOf(':');
    if (tagSeparator === -1) return false;
    return imageWithoutRegistryPort.substring(tagSeparator + 1).toLowerCase() !== 'latest';
  }

  private buildSecurityOverview(summary: SecurityDigestSummary) {
    if (summary.critical > 0) {
      return `${summary.critical} critical finding(s) need immediate attention. Prioritize exposed apps with weak credentials or elevated host access.`;
    }

    if (summary.high > 0) {
      return `${summary.high} high-risk issue(s) were found. Review internet-facing apps, privileged containers, and sensitive host mounts first.`;
    }

    if (summary.findings > 0) {
      return `${summary.findings} lower-priority security finding(s) were detected. The Hub is stable, but there are opportunities to tighten exposure and runtime posture.`;
    }

    return 'No immediate security issues were detected from the current app configuration, container posture, and network exposure.';
  }
}
