/**
 * ICU's canonical id for `zone`, or undefined when it is not a zone we can safely use.
 *
 * Canonicalize rather than merely validate — ICU is lenient in three ways that all bite:
 *
 *   - It has no zone to report at all (`undefined`) when there is no zoneinfo db to match a
 *     bind-mounted /etc/localtime against, i.e. an image without tzdata. This is the undefined
 *     that crashed the .env writer on boot.
 *   - `'Etc/Unknown'` is the CLDR "could not determine" sentinel, and it is TRUTHY — a `||`
 *     guard passes it straight through, and it then throws `RangeError: Invalid time zone
 *     specified` in every downstream Intl consumer.
 *   - Zone ids match case-insensitively, so `'america/new_york'` is *accepted*. Keeping that raw
 *     string is what poisons us: once a non-canonical id lands in process.env.TZ, ICU reports the
 *     host zone as `undefined` — recreating the exact fault this module exists to prevent. So keep
 *     the canonical form ICU resolves to, never the string we were handed.
 *   - It accepts UTC-offset ids (`'+05:00'`, `'-0800'`). Those are not IANA zones: POSIX TZ parsing
 *     in the app containers ignores them and silently falls back to UTC, so the Hub would run on
 *     +05:00 while every container it launched ran UTC. Reject them.
 */
export const canonicalTimeZone = (zone: string | undefined): string | undefined => {
  if (!zone) return undefined;

  let canonical: string | undefined;
  try {
    canonical = Intl.DateTimeFormat(undefined, { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    // RangeError: not a zone ICU knows.
    return undefined;
  }

  if (!canonical || canonical === 'Etc/Unknown') return undefined;
  if (canonical.startsWith('+') || canonical.startsWith('-')) return undefined;

  return canonical;
};

/** The host's canonical IANA zone, or undefined when ICU cannot determine a usable one. */
export const getHostTimeZone = (): string | undefined => canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
