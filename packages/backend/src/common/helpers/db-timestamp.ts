/**
 * Read a timestamp column the way it was written.
 *
 * The schema declares most timestamps as `timestamp` WITHOUT a time zone, read back as strings
 * (`mode: 'string'`), and they are written as UTC: `new Date().toISOString()` from the app, and
 * `now()` from a server whose zone is UTC. Postgres hands such a value back as
 * `2026-10-01 10:00:00.123456`, with no zone, and `Date.parse` / `new Date` read a string like that
 * in the PROCESS's zone. The Hub container mounts the host's `/etc/localtime`, so on any host that
 * is not on UTC every one of these was off by the host's offset.
 *
 * Where that bit: the app-status sync judged an app's `updatedAt` against a grace period, so on a
 * host east of UTC an app mid-update looked hours stale and had its status rewritten from Docker's;
 * west of UTC a stuck app looked newer than it was and was left alone. An API key's expiry moved by
 * the offset, and the portal entitlement and WhoIs caches aged by the wrong amount.
 *
 * A value that already names its zone (`Z`, `+02:00`, `+00`, which `timestamptz` columns and ISO
 * strings carry) is parsed as written. Returns `NaN` for nothing or for text that is not a date, as
 * `Date.parse` does, so callers keep their existing "unreadable" handling.
 */
export function parseDbTimestampMs(value: string | null | undefined): number {
  if (!value) {
    return Number.NaN;
  }

  const text = value.trim();
  const timeStart = text.search(/[ T]\d{2}:\d{2}/);

  // A bare date is already read as UTC.
  if (timeStart === -1) {
    return Date.parse(text);
  }

  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(text.slice(timeStart));

  return Date.parse(hasZone ? text : `${text.replace(' ', 'T')}Z`);
}
