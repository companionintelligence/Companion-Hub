import { z } from 'zod';

/**
 * Why Companion Portal's DNS check answered `available: false` (CI-Portal#846).
 *
 * - `zone_unreachable`: Portal cannot write DNS in the selected domain, so no
 *   subdomain in it will work. The install and port-expose forms put this on the
 *   domain picker and ask for another domain.
 * - `hostname_taken`: A record already exists for the composed hostname. Another
 *   subdomain in the same domain can still work.
 *
 * A Portal older than #846 sends no reason, and a newer one may send a reason this
 * Hub cannot act on. Both reach the forms without one, and the forms treat the
 * answer as a subdomain collision, as they did before #846.
 */
const DNS_UNAVAILABLE_REASONS = ['zone_unreachable', 'hostname_taken'] as const;

type DnsUnavailableReason = (typeof DNS_UNAVAILABLE_REASONS)[number];

export const dnsAvailabilitySchema = z.object({
  available: z.boolean(),
  /** Set only when `available` is false. */
  reason: z.enum(DNS_UNAVAILABLE_REASONS).optional(),
  message: z.string().optional(),
});

export type DnsAvailability = z.infer<typeof dnsAvailabilitySchema>;

function isDnsUnavailableReason(value: unknown): value is DnsUnavailableReason {
  return (DNS_UNAVAILABLE_REASONS as readonly unknown[]).includes(value);
}

/**
 * Reads Portal's DNS check answer, or returns `undefined` when it carries no
 * boolean `available`.
 *
 * Checks each field on its own rather than parsing the whole body. A reason this
 * Hub does not know is dropped and the rest of the answer kept, because rejecting
 * the answer would turn a newer Portal's "taken" into "unable to verify".
 */
export function readDnsAvailability(body: unknown): DnsAvailability | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const { available, reason, message } = body as Record<string, unknown>;

  if (typeof available !== 'boolean') {
    return undefined;
  }

  return {
    available,
    ...(!available && isDnsUnavailableReason(reason) ? { reason } : {}),
    message: typeof message === 'string' ? message : undefined,
  };
}
