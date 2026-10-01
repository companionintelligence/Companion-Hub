/**
 * Comparing marketplace app versions, which are never a JS `Number`.
 *
 * `countUpdatesAvailable` and `getAppUpdateInfo` both compared versions with
 * `Number(a) < Number(b)` / `Number(a) > Number(b)`. Every real app version has more than one
 * decimal point — CI-OpenClaw and CI-Hermes release as `2026.9.14`, `2026.9.21.1`, `v2026.8.9` — and
 * `Number()` on a string with more than one `.` is `NaN`. `NaN < NaN` and `NaN > NaN` are both
 * `false`, so the comparison silently returned "no update" for every app that has ever shipped this
 * way. Measured live: beta-max ran ci-openclaw `2026.9.14` while the marketplace catalog was already
 * bumped to `2026.9.21.1`, and `/api/apps/updates-available` reported 0.
 *
 * `compareAppVersions` treats a version as dot-separated non-negative integers, comparing
 * component-wise with a missing trailing component read as 0 (`2026.9.21` < `2026.9.21.1`) — the same
 * shape `scripts/next-release-tag.sh`/`newest-release-tag.sh` allocate and rank in CI-OpenClaw. A
 * leading `v` is stripped, matching CI-Hermes's `vYYYY.M.D` tags. Anything else (a prerelease suffix,
 * a non-numeric component) is unparseable and returns `null` — the caller decides what "cannot tell"
 * means, rather than this function guessing and being wrong silently the way `Number()` was.
 */
export function parseAppVersion(version: string | null | undefined): number[] | null {
  if (!version) return null;
  const stripped = version.trim().replace(/^[vV]/, '');
  if (!stripped) return null;
  const parts = stripped.split('.');
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  return nums.length > 0 ? nums : null;
}

/**
 * `a` vs `b`: negative when `a` < `b`, positive when `a` > `b`, `0` when equal, `null` when either
 * side could not be parsed. `null` is a distinct answer from `0` — an unparseable version must never
 * read as "up to date", which is exactly the bug this replaces.
 */
export function compareAppVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const pa = parseAppVersion(a);
  const pb = parseAppVersion(b);
  if (pa === null || pb === null) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Whether the catalog has an update for an installed app.
 *
 * ONE definition, because three things used to answer this question separately and disagreed: the
 * "updates available" badge, the per-app Update button, and the update-all sweep. The badge counted an
 * image bump (the CI-OpenClaw and CI-Hermes case) that the sweep never looked at, so a dashboard that
 * offered "Update all" for it updated nothing.
 *
 * Two signals, either of which is an update:
 *   - the schema counter (`cihub_app_version`) went up, unless the operator ignored that version;
 *   - the image version string (`version` in config.json) is newer than the installed one.
 *
 * Ignoring is recorded against the counter only, so it cannot silence an image bump.
 */
export function hasUpdateAvailable(input: {
  installedCounter: number | string | null | undefined;
  latestCounter: number | string | null | undefined;
  ignoredCounter?: number | string | null;
  installedVersion: string | null | undefined;
  latestVersion: string | null | undefined;
}): boolean {
  const counterBumped =
    Number(input.installedCounter) < Number(input.latestCounter ?? 0) && (input.ignoredCounter ?? null) !== (input.latestCounter ?? null);

  if (counterBumped) {
    return true;
  }

  const versionComparison = compareAppVersions(input.installedVersion, input.latestVersion);

  return versionComparison !== null && versionComparison < 0;
}
