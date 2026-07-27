#!/usr/bin/env tsx
/**
 * Probe physical host RAM, CPU, and disk before Hub containers start.
 * Writes state/hardware/host_metrics.json under the configured state directory
 * (CI_HUB_STATE_PATH/STATE_PATH, ROOT_FOLDER_HOST/state, or .internal/state).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import si from 'systeminformation';
import { parseEnvFile } from './env-file';
import { isDirectScriptRun } from './lib/is-direct-run';

interface HostFirewallInfo {
  kind: 'ufw' | 'firewalld' | 'nftables' | 'iptables' | 'none' | 'unknown';
  active: boolean;
}

interface HostMetricsProbeFile {
  schemaVersion: 1;
  platform: 'darwin' | 'win32' | 'linux';
  cpuArch: 'arm64' | 'x86_64';
  source: 'init-host-probe';
  probedAt: string;
  host: {
    totalRamMb: number;
    availableRamMb: number;
    cpuCores: number;
    cpuModel?: string;
    diskTotalGb: number;
    diskUsedGb: number;
    diskMount: string;
  };
  firewall?: HostFirewallInfo;
}

function resolveStateDir(): string {
  const internalDir = process.env.CI_HUB_STATE_PATH || process.env.STATE_PATH;
  if (internalDir) return path.join(internalDir, 'state');

  const envFile = process.env.ENV_FILE;
  if (envFile) {
    const fromEnvFile = parseEnvFile(path.resolve(process.cwd(), envFile)).ROOT_FOLDER_HOST;
    if (fromEnvFile) {
      const rootFolder = path.isAbsolute(fromEnvFile) ? fromEnvFile : path.resolve(process.cwd(), fromEnvFile);
      return path.join(rootFolder, 'state');
    }
  }

  const rootFromEnv = process.env.ROOT_FOLDER_HOST;
  if (rootFromEnv) {
    const rootFolder = path.isAbsolute(rootFromEnv) ? rootFromEnv : path.resolve(process.cwd(), rootFromEnv);
    return path.join(rootFolder, 'state');
  }

  return path.resolve(process.cwd(), '.internal', 'state');
}

function normalizePlatform(): HostMetricsProbeFile['platform'] {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

function normalizeCpuArch(): HostMetricsProbeFile['cpuArch'] {
  return os.arch() === 'arm64' ? 'arm64' : 'x86_64';
}

function pickPrimaryFilesystem(filesystems: si.Systeminformation.FsSizeData[]) {
  if (filesystems.length === 0) return null;

  if (process.platform === 'win32') {
    // `fs`/`mount` are typed as required, but real systeminformation output can omit
    // them for unusual volumes. Optional-chain the string ops so a single sparse drive
    // entry can't crash the whole host probe — it simply won't match and we fall back
    // to the first filesystem (and diskMount defaults to 'C:' downstream).
    return (
      filesystems.find((entry) => entry.mount === 'C:' || entry.fs?.toUpperCase()?.startsWith('C:')) ??
      filesystems.find((entry) => entry.mount?.toUpperCase()?.startsWith('C')) ??
      filesystems[0]
    );
  }

  return filesystems.find((entry) => entry.mount === '/') ?? [...filesystems].sort((a, b) => b.size - a.size)[0];
}

const DARWIN_DATA_MOUNT = '/System/Volumes/Data';

interface StorageVolumeEntry {
  _name?: string;
  mount_point?: string;
  size_in_bytes?: number;
  free_space_in_bytes?: number;
}

/** Matches macOS System Settings storage totals (decimal GB on the Data APFS volume). */
function probeDarwinDiskFromStorageProfiler(): { diskTotalGb: number; diskUsedGb: number; diskMount: string } | null {
  const result = spawnSync('system_profiler', ['SPStorageDataType', '-json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return null;

  try {
    const parsed = JSON.parse(result.stdout) as { SPStorageDataType?: StorageVolumeEntry[] };
    const volumes = parsed.SPStorageDataType ?? [];
    const dataVol =
      volumes.find((entry) => entry.mount_point === DARWIN_DATA_MOUNT) ??
      volumes.find((entry) => entry._name === 'Macintosh HD') ??
      volumes.find((entry) => entry.mount_point === '/');
    const sizeBytes = dataVol?.size_in_bytes;
    if (!sizeBytes || sizeBytes <= 0) return null;

    const freeBytes = dataVol?.free_space_in_bytes ?? 0;
    const usedBytes = Math.max(0, sizeBytes - freeBytes);

    return {
      diskTotalGb: Math.round(sizeBytes / 1e9),
      diskUsedGb: Math.round(usedBytes / 1e9),
      diskMount: dataVol?.mount_point ?? DARWIN_DATA_MOUNT,
    };
  } catch {
    return null;
  }
}

function probeDarwinDiskFromDf(mount: string): { diskTotalGb: number; diskUsedGb: number; diskMount: string } | null {
  const result = spawnSync('df', ['-k', mount], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return null;

  const line = result.stdout.split('\n')[1]?.trim();
  if (!line) return null;

  const fields = line.split(/\s+/);
  if (fields.length < 6) return null;

  const totalKb = Number.parseInt(fields[1] ?? '', 10);
  const usedKb = Number.parseInt(fields[2] ?? '', 10);
  if (!Number.isFinite(totalKb) || totalKb <= 0 || !Number.isFinite(usedKb) || usedKb < 0) return null;

  return {
    diskTotalGb: Math.round(totalKb / 1024 / 1024),
    diskUsedGb: Math.round(usedKb / 1024 / 1024),
    diskMount: fields.at(-1) ?? mount,
  };
}

/** APFS user storage lives on the Data volume; df on "/" only sees the sealed system snapshot. */
function probeDarwinDiskGb(): { diskTotalGb: number; diskUsedGb: number; diskMount: string } | null {
  return probeDarwinDiskFromStorageProfiler() ?? probeDarwinDiskFromDf(DARWIN_DATA_MOUNT) ?? probeDarwinDiskFromDf('/');
}

function runQuiet(command: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 3000 });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() };
}

function isSystemdUnitActive(unit: string): boolean {
  return runQuiet('systemctl', ['is-active', unit]).stdout === 'active';
}

function hasBinary(name: string): boolean {
  return runQuiet('sh', ['-c', `command -v ${name}`]).ok;
}

/** `ufw status` requires root; ENABLED lives in a world-readable config instead. */
function isUfwEnabledInConfig(): boolean {
  try {
    return /^ENABLED=yes/im.test(readFileSync('/etc/ufw/ufw.conf', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Identify the host's packet filter.
 *
 * The Hub backend runs in a container and cannot see this, so it is captured
 * here and read back from the probe file. Without it the Hub can only guess at
 * the syntax when telling an operator how to unblock the Docker bridge.
 *
 * Everything here must work unprivileged — this script does not run as root.
 */
export function probeHostFirewall(): HostFirewallInfo {
  if (process.platform !== 'linux') return { kind: 'none', active: false };

  // ufw is a frontend over nftables/iptables, so it is checked first: on a ufw
  // host the nftables unit may also be active, but ufw syntax is what the
  // operator should use.
  if (hasBinary('ufw') && (isSystemdUnitActive('ufw') || isUfwEnabledInConfig())) {
    return { kind: 'ufw', active: true };
  }
  if (isSystemdUnitActive('firewalld')) return { kind: 'firewalld', active: true };
  if (isSystemdUnitActive('nftables')) return { kind: 'nftables', active: true };

  // Tooling present but nothing reports as enforcing. Distinguished from
  // `unknown` so the Hub does not blame a firewall that is switched off.
  if (hasBinary('ufw') || hasBinary('nft') || hasBinary('iptables')) {
    return { kind: 'none', active: false };
  }
  return { kind: 'unknown', active: false };
}

export async function probeHostMetrics(): Promise<HostMetricsProbeFile> {
  const [mem, cpu, fsSizes] = await Promise.all([si.mem(), si.cpu(), si.fsSize()]);
  const darwinDisk = process.platform === 'darwin' ? probeDarwinDiskGb() : null;
  const disk = darwinDisk ? null : pickPrimaryFilesystem(fsSizes);

  const diskTotalGb = darwinDisk?.diskTotalGb ?? (disk ? Math.round(disk.size / 1024 / 1024 / 1024) : 0);
  const diskUsedGb =
    darwinDisk?.diskUsedGb ?? (disk ? Math.max(0, Math.round(disk.size / 1024 / 1024 / 1024) - Math.round(disk.available / 1024 / 1024 / 1024)) : 0);
  const diskMount = darwinDisk?.diskMount ?? disk?.mount ?? (process.platform === 'win32' ? 'C:' : '/');

  return {
    schemaVersion: 1,
    platform: normalizePlatform(),
    cpuArch: normalizeCpuArch(),
    source: 'init-host-probe',
    probedAt: new Date().toISOString(),
    host: {
      totalRamMb: Math.max(1, Math.round(mem.total / 1024 / 1024)),
      availableRamMb: Math.max(0, Math.round(mem.available / 1024 / 1024)),
      cpuCores: cpu?.cores || os.cpus().length,
      cpuModel: cpu?.brand ? `${cpu.manufacturer} ${cpu.brand}`.trim() : undefined,
      diskTotalGb,
      diskUsedGb,
      diskMount,
    },
    firewall: probeHostFirewall(),
  };
}

export async function initHostProbe(): Promise<HostMetricsProbeFile> {
  const stateDir = resolveStateDir();
  const outPath = path.join(stateDir, 'hardware', 'host_metrics.json');
  mkdirSync(path.dirname(outPath), { recursive: true });

  const probe = await probeHostMetrics();
  writeFileSync(outPath, `${JSON.stringify(probe, null, 2)}\n`, 'utf8');
  const firewall = probe.firewall?.active ? `, firewall ${probe.firewall.kind} active` : '';
  console.log(
    `init-host-probe: wrote ${outPath} (${probe.host.totalRamMb} MB RAM, ${probe.host.diskUsedGb}/${probe.host.diskTotalGb} GB disk on ${probe.host.diskMount}${firewall})`,
  );
  return probe;
}

async function main() {
  await initHostProbe();
}

const isDirectRun = isDirectScriptRun(import.meta.url, import.meta.main);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`init-host-probe: failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
