import fs from 'node:fs';
import path from 'node:path';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { securityGrantsFor } from '@/modules/apps/security-grants';
import { type BindMountRef, bindSourceKey, describeNestedBindMounts, findNestedBindMounts } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import * as yaml from 'yaml';

/**
 * An app refused because one of its bind mounts sits inside another folder it can write to
 * (`findNestedBindMounts`). Its own class so the refusal reaches the person as itself, with an error
 * code the app page and its toasts can name, instead of as a compose file that could not be made.
 */
export class NestedBindMountsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NestedBindMountsError';
  }
}

/**
 * The refusal of a manifest whose bind mounts sit inside another folder the app can write to
 * (`findNestedBindMounts`, with the host paths the app is granted allowed), or `null` when none do.
 * Read from the manifest's own paths: the builder refuses an install with it, and an update refuses
 * a new version with it before it takes the running one down.
 */
export function nestedManifestMountsRefusal(
  services: readonly { name: string; volumes?: readonly { hostPath?: string; readOnly?: boolean }[] }[],
  appUrn: AppUrn,
): NestedBindMountsError | null {
  const nestedMounts = findNestedBindMounts(
    services.flatMap((service) =>
      (service.volumes ?? []).flatMap((volume) =>
        volume.hostPath === undefined ? [] : [{ service: service.name, source: volume.hostPath, readOnly: volume.readOnly === true }],
      ),
    ),
    { grantedHostPaths: securityGrantsFor(appUrn).hostPaths },
  );
  if (nestedMounts.length === 0) {
    return null;
  }
  return new NestedBindMountsError(
    `App "${extractAppUrn(appUrn).appName}" mounts a folder inside another folder it can write to: ${describeNestedBindMounts(nestedMounts)}. ` +
      'Code in the app could replace the inner folder with a link to anywhere on this computer. Give each mount a folder of its own, side by side.',
  );
}

/**
 * The bind mounts in `docker compose config` output: the app's compose as Compose will run it, with
 * the user override merged in and every `${...}` expanded.
 *
 * Compose v2 prints long syntax (`type: bind`, `source`, `target`, `read_only`); the v1 binary the Hub
 * falls back to prints short syntax (`/host:/container[:ro]`). Both are read. Named volumes, tmpfs and
 * anything that is not a host folder are left out: they expose no host path a link could redirect.
 */
export function parseComposeConfigBindMounts(configYaml: string): BindMountRef[] {
  const parsed = yaml.parse(configYaml) as { services?: Record<string, { volumes?: unknown[] }> } | null;
  const mounts: BindMountRef[] = [];
  for (const [service, definition] of Object.entries(parsed?.services ?? {})) {
    for (const volume of definition?.volumes ?? []) {
      const mount = typeof volume === 'string' ? shortSyntaxBind(volume) : longSyntaxBind(volume);
      if (mount) {
        mounts.push({ service, ...mount });
      }
    }
  }
  return mounts;
}

function longSyntaxBind(volume: unknown): Omit<BindMountRef, 'service'> | null {
  if (!volume || typeof volume !== 'object') {
    return null;
  }
  const { type, source, read_only: readOnly } = volume as { type?: unknown; source?: unknown; read_only?: unknown };
  if (type !== 'bind' || typeof source !== 'string' || source === '') {
    return null;
  }
  return { source, readOnly: readOnly === true };
}

/** `source:target[:options]`, where a Windows source keeps its drive letter (`C:\data:/data:ro`). */
function shortSyntaxBind(volume: string): Omit<BindMountRef, 'service'> | null {
  const drive = /^[A-Za-z]:[\\/]/.test(volume) ? volume.slice(0, 2) : '';
  const parts = volume.slice(drive.length).split(':');
  const source = drive + (parts[0] ?? '');
  // A bare name is a named volume; only a path is a bind.
  if (parts.length < 2 || !(source.startsWith('/') || source.startsWith('.') || drive)) {
    return null;
  }
  const options = (parts[2] ?? '').split(',');
  return { source, readOnly: options.includes('ro') };
}

/**
 * Where `hostSource` sits inside `hostAppDataDir`, as path segments, or `null` when it is outside it.
 * Compared the way a Mac or Windows disk compares (case and slashes ignored), since that is the disk
 * Docker will mount from.
 */
export function segmentsInside(hostAppDataDir: string, hostSource: string): string[] | null {
  const dirKey = bindSourceKey(hostAppDataDir);
  const sourceKey = bindSourceKey(hostSource);
  if (sourceKey !== dirKey && !sourceKey.startsWith(`${dirKey}/`)) {
    return null;
  }
  // Lower-casing can change a string's length outside ASCII; the slashes are the same in both forms,
  // so count segments rather than characters.
  const dirSegments = dirKey.split('/').filter(Boolean).length;
  return hostSource.replace(/\\/g, '/').split('/').filter(Boolean).slice(dirSegments);
}

/**
 * The first part of `root/segments...` that is a symbolic link, as a path relative to `root`, or
 * `null` when there is none. Parts that do not exist yet end the walk: Docker or the Hub creates
 * them as plain folders.
 */
export async function firstLinkOnTheWay(root: string, segments: readonly string[]): Promise<string | null> {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.promises.lstat(current).catch(() => null);
    if (!stat) {
      return null;
    }
    if (stat.isSymbolicLink()) {
      return segments.slice(0, index + 1).join('/');
    }
  }
  return null;
}
