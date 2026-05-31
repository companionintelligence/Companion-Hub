#!/usr/bin/env tsx
/**
 * Probe physical host RAM, CPU, and disk before Hub containers start.
 * Writes state/hardware/host_metrics.json under the configured state directory
 * (CI_HUB_STATE_PATH/STATE_PATH, ROOT_FOLDER_HOST/state, or .internal/state).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import si from 'systeminformation';

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

function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
  } catch {
    // ignore
  }
  return values;
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
    return (
      filesystems.find((entry) => entry.mount === 'C:' || entry.fs.toUpperCase().startsWith('C:')) ??
      filesystems.find((entry) => entry.mount.toUpperCase().startsWith('C')) ??
      filesystems[0]
    );
  }

  return filesystems.find((entry) => entry.mount === '/') ?? [...filesystems].sort((a, b) => b.size - a.size)[0];
}

export async function probeHostMetrics(): Promise<HostMetricsProbeFile> {
  const [mem, cpu, fsSizes] = await Promise.all([si.mem(), si.cpu(), si.fsSize()]);
  const disk = pickPrimaryFilesystem(fsSizes);

  const diskTotalGb = disk ? Math.round(disk.size / 1024 / 1024 / 1024) : 0;
  const diskFreeGb = disk ? Math.round(disk.available / 1024 / 1024 / 1024) : 0;

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
      diskUsedGb: Math.max(0, diskTotalGb - diskFreeGb),
      diskMount: disk?.mount || (process.platform === 'win32' ? 'C:' : '/'),
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

const isDirectRun = process.argv[1]?.endsWith('init-host-probe.ts') || process.argv[1]?.includes('init-host-probe');
if (isDirectRun) {
  main().catch((error) => {
    console.error(`init-host-probe: failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
