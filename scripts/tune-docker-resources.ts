#!/usr/bin/env tsx
/**
 * Raise Docker Desktop / WSL2 memory toward a safe host maximum on first Hub start.
 * Linux native Docker is a no-op. Never reduces existing limits.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OS_RESERVE_MB = 4096;
const MIN_DOCKER_RAM_MB = 8192;
const HOST_RAM_FRACTION = 0.75;

interface DockerTuningRecord {
  attemptedAt: string;
  platform: string;
  action: 'skipped' | 'updated' | 'noop' | 'failed';
  reason: string;
  previousMemoryMb?: number;
  targetMemoryMb?: number;
  appliedMemoryMb?: number;
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

function readHostRamMb(): number {
  try {
    const metricsPath = path.join(resolveStateDir(), 'hardware', 'host_metrics.json');
    if (!existsSync(metricsPath)) return 0;
    const parsed = JSON.parse(readFileSync(metricsPath, 'utf8')) as { host?: { totalRamMb?: number } };
    return typeof parsed.host?.totalRamMb === 'number' ? parsed.host.totalRamMb : 0;
  } catch {
    return Math.round(os.totalmem() / 1024 / 1024);
  }
}

function recommendedDockerRamMb(hostRamMb: number): number {
  if (hostRamMb <= 0) return MIN_DOCKER_RAM_MB;
  const capped = Math.floor(hostRamMb * HOST_RAM_FRACTION);
  const reserved = Math.max(0, hostRamMb - OS_RESERVE_MB);
  return Math.max(MIN_DOCKER_RAM_MB, Math.min(capped, reserved, hostRamMb));
}

function writeTuningRecord(record: DockerTuningRecord) {
  const outPath = path.join(resolveStateDir(), 'hardware', 'docker-tuning.json');
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tuneMacOsDocker(hostRamMb: number): DockerTuningRecord {
  const settingsPath = path.join(os.homedir(), 'Library', 'Group Containers', 'group.com.docker', 'settings-store.json');
  const target = recommendedDockerRamMb(hostRamMb);
  const settings = readJsonFile(settingsPath);
  if (!settings) {
    return {
      attemptedAt: new Date().toISOString(),
      platform: 'darwin',
      action: 'skipped',
      reason: 'Docker Desktop settings-store.json not found',
      targetMemoryMb: target,
    };
  }

  const current = typeof settings.MemoryMiB === 'number' ? settings.MemoryMiB : 0;
  if (current >= target) {
    return {
      attemptedAt: new Date().toISOString(),
      platform: 'darwin',
      action: 'noop',
      reason: 'Docker memory already at or above recommended value',
      previousMemoryMb: current,
      targetMemoryMb: target,
      appliedMemoryMb: current,
    };
  }

  settings.MemoryMiB = target;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return {
    attemptedAt: new Date().toISOString(),
    platform: 'darwin',
    action: 'updated',
    reason: 'Increased Docker Desktop MemoryMiB (restart Docker Desktop to apply)',
    previousMemoryMb: current,
    targetMemoryMb: target,
    appliedMemoryMb: target,
  };
}

function parseWslMemoryMb(content: string): number | null {
  const match = content.match(/^\s*memory\s*=\s*(\d+)\s*(GB|MB)?/im);
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (match[2] || 'MB').toUpperCase();
  return unit === 'GB' ? value * 1024 : value;
}

function upsertWslConfigLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'im');
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  const trimmed = content.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n` : '[wsl2]\n';
  if (!/\[wsl2\]/i.test(prefix)) {
    return `[wsl2]\n${line}\n`;
  }
  return `${prefix}${line}\n`;
}

function tuneWindowsWsl(hostRamMb: number): DockerTuningRecord {
  const wslConfigPath = path.join(os.homedir(), '.wslconfig');
  const target = recommendedDockerRamMb(hostRamMb);
  const targetGb = Math.max(1, Math.round(target / 1024));
  const existing = existsSync(wslConfigPath) ? readFileSync(wslConfigPath, 'utf8') : '[wsl2]\n';
  const current = parseWslMemoryMb(existing) ?? 0;

  if (current >= target) {
    return {
      attemptedAt: new Date().toISOString(),
      platform: 'win32',
      action: 'noop',
      reason: 'WSL memory already at or above recommended value',
      previousMemoryMb: current,
      targetMemoryMb: target,
      appliedMemoryMb: current,
    };
  }

  let updated = upsertWslConfigLine(existing, 'memory', `${targetGb}GB`);
  const hostCores = os.cpus().length;
  if (hostCores > 0 && !/^\s*processors\s*=/im.test(updated)) {
    updated = upsertWslConfigLine(updated, 'processors', String(Math.min(hostCores, 12)));
  }
  writeFileSync(wslConfigPath, updated.endsWith('\n') ? updated : `${updated}\n`, 'utf8');

  spawnSync('wsl.exe', ['--shutdown'], { stdio: 'ignore' });

  return {
    attemptedAt: new Date().toISOString(),
    platform: 'win32',
    action: 'updated',
    reason: 'Updated .wslconfig memory (restart Docker Desktop to apply)',
    previousMemoryMb: current,
    targetMemoryMb: target,
    appliedMemoryMb: target,
  };
}

function main() {
  if (process.env.CI_HUB_SKIP_DOCKER_TUNING === '1') {
    writeTuningRecord({
      attemptedAt: new Date().toISOString(),
      platform: process.platform,
      action: 'skipped',
      reason: 'CI_HUB_SKIP_DOCKER_TUNING=1',
    });
    console.log('tune-docker-resources: skipped (CI_HUB_SKIP_DOCKER_TUNING=1)');
    return;
  }

  const tuningPath = path.join(resolveStateDir(), 'hardware', 'docker-tuning.json');
  if (existsSync(tuningPath) && process.env.CI_HUB_FORCE_DOCKER_TUNING !== '1') {
    console.log('tune-docker-resources: already tuned; set CI_HUB_FORCE_DOCKER_TUNING=1 to retry');
    return;
  }

  const hostRamMb = readHostRamMb();
  let record: DockerTuningRecord;

  if (process.platform === 'linux') {
    record = {
      attemptedAt: new Date().toISOString(),
      platform: 'linux',
      action: 'noop',
      reason: 'Native Linux Docker uses host resources directly',
      targetMemoryMb: hostRamMb,
    };
  } else if (process.platform === 'darwin') {
    record = tuneMacOsDocker(hostRamMb);
  } else if (process.platform === 'win32') {
    record = tuneWindowsWsl(hostRamMb);
  } else {
    record = {
      attemptedAt: new Date().toISOString(),
      platform: process.platform,
      action: 'skipped',
      reason: 'Unsupported platform for Docker tuning',
    };
  }

  writeTuningRecord(record);
  console.log(`tune-docker-resources: ${record.action} — ${record.reason}`);
}

main();
