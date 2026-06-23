#!/usr/bin/env tsx
/**
 * Probe physical host RAM, CPU, and disk before Hub containers start.
 * Writes state/hardware/host_metrics.json under the configured state directory
 * (CI_HUB_STATE_PATH/STATE_PATH, ROOT_FOLDER_HOST/state, or .internal/state).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import si from 'systeminformation';
import { parseEnvFile } from './env-file';
import { isDirectScriptRun } from './lib/is-direct-run';

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
  };
}

async function main() {
  const stateDir = resolveStateDir();
  const outPath = path.join(stateDir, 'hardware', 'host_metrics.json');
  mkdirSync(path.dirname(outPath), { recursive: true });

  const probe = await probeHostMetrics();
  writeFileSync(outPath, `${JSON.stringify(probe, null, 2)}\n`, 'utf8');
  console.log(
    `init-host-probe: wrote ${outPath} (${probe.host.totalRamMb} MB RAM, ${probe.host.diskUsedGb}/${probe.host.diskTotalGb} GB disk on ${probe.host.diskMount})`,
  );
}

const isDirectRun = isDirectScriptRun(import.meta.url, import.meta.main);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`init-host-probe: failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
