/**
 * One bind mount's host folder inside another's that a container can write to.
 *
 * ⚠ THAT IS A HOST ESCAPE. Docker follows symbolic links in a bind mount's source every time it
 * starts the container, not only when it creates it. With `data` mounted writable and `data/cfg`
 * mounted somewhere else, code in the container can replace `data/cfg` with a link to `/`. The next
 * start — Docker's own restart after the container exits, or every container at boot, with no Hub
 * involved — mounts the host's root where `data/cfg` was. So the Hub refuses the shape itself: no
 * source may sit inside another source that any service mounts writable. Read-only outer mounts are
 * fine (nothing in a container can plant a link through them), and so is a host path the app is
 * granted outright (`TRUSTED_APP_SECURITY_ALLOWLIST`), which already gives it everything under it.
 *
 * Two services mounting the SAME folder is not nesting and stays allowed: neither can replace the
 * other's source, since each one's source is the root of its own mount.
 */

/** One bind mount as the check needs it: whose it is, its host folder, and whether it is read-only. */
export interface BindMountRef {
  /** The service (or `app/service`, across apps) that mounts it. Only used to name it in a refusal. */
  service: string;
  /** The host path, as Compose will hand it to Docker. `${APP_DATA_DIR}` may be left in. */
  source: string;
  readOnly: boolean;
}

export interface NestedBindMount {
  /** The writable mount whose folder holds the other one's source. */
  outer: BindMountRef;
  /** The mount whose source a container could replace through `outer`. */
  inner: BindMountRef;
}

/**
 * The form two paths are compared in: forward slashes, no repeated or trailing slash, lower case.
 * Lower case because the disks a Hub runs on under Docker Desktop (APFS, NTFS) ignore case, so
 * `data/Cfg` IS `data/cfg` there. On Linux this can refuse two folders that differ only in case,
 * which no manifest needs.
 */
export function bindSourceKey(source: string): string {
  const slashed = source.replace(/\\/g, '/').replace(/\/+/g, '/');
  const trimmed = slashed.length > 1 && slashed.endsWith('/') ? slashed.slice(0, -1) : slashed;
  return trimmed.toLowerCase();
}

const isInside = (inner: string, outer: string) => inner !== outer && (outer === '/' ? inner.startsWith('/') : inner.startsWith(`${outer}/`));

/**
 * Every pair where one mount's source sits inside another's that a service mounts writable.
 *
 * @param grantedHostPaths host paths this app is granted outright; one of them as the outer folder is
 *   not refused, since the grant already hands over everything below it.
 */
export function findNestedBindMounts(mounts: readonly BindMountRef[], options?: { grantedHostPaths?: readonly string[] }): NestedBindMount[] {
  const granted = new Set((options?.grantedHostPaths ?? []).map(bindSourceKey));
  const nested: NestedBindMount[] = [];
  for (const outer of mounts) {
    const outerKey = bindSourceKey(outer.source);
    if (outer.readOnly || granted.has(outerKey)) {
      continue;
    }
    for (const inner of mounts) {
      if (isInside(bindSourceKey(inner.source), outerKey)) {
        nested.push({ outer, inner });
      }
    }
  }
  return nested;
}

/** One line per pair, for an error a person reads. */
export function describeNestedBindMounts(nested: readonly NestedBindMount[]): string {
  return nested
    .map(({ outer, inner }) => `"${inner.source}" (${inner.service}) is inside "${outer.source}", which ${outer.service} can write to`)
    .join('; ');
}
