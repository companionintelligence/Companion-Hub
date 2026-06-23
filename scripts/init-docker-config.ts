#!/usr/bin/env tsx
/**
 * Generate a container-safe Docker config.json for the Hub container.
 *
 * The Hub container runs the Docker CLI inside Linux and talks to the host's
 * Docker daemon via /var/run/docker.sock. It therefore cannot inherit
 * host-specific fields from the developer's ~/.docker/config.json, notably:
 *
 *   - "currentContext" values like "desktop-linux" (Docker Desktop on macOS)
 *     point at daemon sockets that don't exist inside the container.
 *   - "credsStore": "desktop" (macOS/Windows), "osxkeychain", "wincred,
 *     "secretservice", or "pass" all require host-side binaries that the
 *     Linux container image does not ship.
 *   - "plugins", "features", and "hooks" reference host CLI plugins that
 *     aren't installed inside the container and can break compose invocations.
 *
 * If we naively bind-mount the host config, the Hub's docker-compose calls
 * (when installing marketplace apps) fail with errors like:
 *
 *   unable to resolve docker endpoint: context "desktop-linux": context not
 *   found: open /root/.docker/contexts/meta/.../meta.json: no such file or
 *   directory
 *
 * This script reads the host config, strips anything that only works on the
 * host, and writes the result to {ROOT}/.docker/config.json. Compose mounts
 * {ROOT_FOLDER_HOST}/.docker at /data/.docker (DOCKER_CONFIG=/data/.docker).
 *
 * Registry auths that carry inline credentials (`auth` field) are preserved so
 * private image pulls keep working.
 */

import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDirectScriptRun } from './lib/is-direct-run';
import { resolveRootFolderHostForRuntime } from './lib/paths';

const HOST_CONFIG_PATH = path.join(os.homedir(), '.docker', 'config.json');

// Credential-store values that rely on host-only binaries and will fail inside
// the Linux container if forwarded.
const HOST_ONLY_CREDSTORES = new Set(['desktop', 'osxkeychain', 'wincred', 'secretservice', 'pass']);

function resolveRootFolderHost(): string {
  return resolveRootFolderHostForRuntime();
}

function isHostOnlyCredHelper(value: string): boolean {
  return HOST_ONLY_CREDSTORES.has(value);
}

async function readHostConfig(): Promise<Record<string, unknown>> {
  if (!existsSync(HOST_CONFIG_PATH)) return {};
  try {
    const raw = await readFile(HOST_CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.warn(`init-docker-config: could not parse ${HOST_CONFIG_PATH}: ${(err as Error).message}`);
    return {};
  }
}

function sanitizeAuths(auths: unknown): Record<string, { auth: string }> {
  if (!auths || typeof auths !== 'object') return {};
  const result: Record<string, { auth: string }> = {};
  for (const [registry, entry] of Object.entries(auths as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.auth === 'string' && e.auth.length > 0) {
      result[registry] = { auth: e.auth };
    }
  }
  return result;
}

function sanitizeCredHelpers(helpers: unknown): Record<string, string> {
  if (!helpers || typeof helpers !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [registry, helper] of Object.entries(helpers as Record<string, unknown>)) {
    if (typeof helper === 'string' && !isHostOnlyCredHelper(helper)) {
      result[registry] = helper;
    }
  }
  return result;
}

async function migrateLegacyConfig(root: string, outputPath: string): Promise<void> {
  const legacyPaths = [path.join(root, 'docker-config.json'), path.join(root, '.internal', 'docker-config.json')];
  if (existsSync(outputPath)) return;
  for (const legacy of legacyPaths) {
    if (!existsSync(legacy)) continue;
    try {
      await copyFile(legacy, outputPath);
      console.log(`init-docker-config: migrated ${legacy} -> ${outputPath}`);
      return;
    } catch (err) {
      console.warn(`init-docker-config: could not migrate ${legacy}: ${(err as Error).message}`);
    }
  }
}

export async function initDockerConfig(): Promise<void> {
  const root = resolveRootFolderHost();
  const dockerDir = path.join(root, '.docker');
  const cliPluginsDir = path.join(dockerDir, 'cli-plugins');
  const outputPath = path.join(dockerDir, 'config.json');

  const hostConfig = await readHostConfig();
  const sanitized: Record<string, unknown> = {};

  const auths = sanitizeAuths(hostConfig.auths);
  if (Object.keys(auths).length > 0) sanitized.auths = auths;

  if (typeof hostConfig.credsStore === 'string' && !isHostOnlyCredHelper(hostConfig.credsStore)) {
    sanitized.credsStore = hostConfig.credsStore;
  }

  const credHelpers = sanitizeCredHelpers(hostConfig.credHelpers);
  if (Object.keys(credHelpers).length > 0) sanitized.credHelpers = credHelpers;

  await mkdir(root, { recursive: true });
  await mkdir(cliPluginsDir, { recursive: true });
  await migrateLegacyConfig(root, outputPath);

  if (!existsSync(outputPath) || Object.keys(sanitized).length > 0) {
    await writeFile(outputPath, `${JSON.stringify(sanitized, null, 2)}\n`);
  }
  await chmod(outputPath, 0o600);

  const summary: string[] = [];
  if (sanitized.auths) summary.push(`${Object.keys(sanitized.auths as object).length} registry auth(s)`);
  if (sanitized.credsStore) summary.push(`credsStore=${sanitized.credsStore as string}`);
  if (sanitized.credHelpers) summary.push(`${Object.keys(sanitized.credHelpers as object).length} credHelper(s)`);
  console.log(`init-docker-config: ready ${outputPath}${summary.length > 0 ? ` (${summary.join(', ')})` : ''}`);
}

const isDirectRun = isDirectScriptRun(import.meta.url, import.meta.main);

if (isDirectRun) {
  initDockerConfig().catch((err) => {
    console.error('init-docker-config failed:', err);
    process.exit(1);
  });
}
