import { scrubString } from '@/core/error-reporting/sentry-scrubber';

/**
 * What a Portal answer to `POST /api/devices/check-in` means for this Hub.
 *
 * - `accepted`: Portal knows this device key and recorded the check-in.
 * - `rejected`: Portal answered, and it does not accept this Hub as the device its key names.
 *   Retrying cannot change that. Only pairing again can.
 * - `refused_body`: Portal refused the request body. That is a schema mismatch between the two
 *   builds, not a verdict on the device, so it must never cost the Hub its registration.
 * - `failed`: anything else — 5xx, a rate limit, or a page from something in front of Portal.
 */
export type CheckInVerdict =
  | { kind: 'accepted'; code: null; error: null }
  | { kind: 'rejected' | 'refused_body' | 'failed'; code: string | null; error: string };

const MAX_ERROR_LENGTH = 200;

/**
 * Classifies a check-in response against the contract CI-Portal actually implements.
 *
 * The contract, read from CI-Portal `dev` (`CheckIn.ts`, `deviceAuthMiddleware.ts`, `DeviceService.findByApiKey`):
 *
 * | Portal answer | Cause |
 * | --- | --- |
 * | `401 UNAUTHORIZED` | No key, or no live device holds it: the device was removed, an owner or admin re-registered it (status `inactive`, refused since CI-Portal 05b84f3, 2026-09-08), or a later pair rotated the key |
 * | `403` with a JSON `error` | The key authenticates as a different `device_id` than the one this Hub resolved |
 * | `400 DEVICE_NOT_ACTIVE` | The device row vanished between authentication and the handler's read |
 * | `400` with any other body | `zValidator` refused a field this Hub sent |
 *
 * The Hub used to read every 400 as "removed" and delete its registration, and every 401 as a
 * transient failure. That is backwards for the fleet. A removal answers 401, so on 2026-09-17 five
 * paired Hubs had retried a dead key for up to a week under `cloud_validation_failed`, which tells
 * an owner to wait rather than to pair again. And the one 400 that is not a removal, a schema
 * refusal, was the one that wiped a healthy Hub's tunnel token; CI-Portal's own `CheckIn.ts` warns
 * that a vocabulary mismatch there "makes every healthy Hub in the fleet unpair itself".
 *
 * A 401 or 403 counts only when the body is a JSON object, which is how Portal's `respond()`
 * answers. A page from Cloudflare or a captive proxy arrives as a string, and it says nothing
 * about this device.
 */
export function classifyCheckInResponse(status: number, body: unknown): CheckInVerdict {
  if (status >= 200 && status < 300) {
    return { kind: 'accepted', code: null, error: null };
  }

  const object = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const code = typeof object?.code === 'string' && object.code.trim() ? object.code.trim() : null;
  const error = describePortalError(status, object);

  if (object && (status === 401 || (status === 403 && typeof object.error === 'string'))) {
    return { kind: 'rejected', code, error };
  }

  if (status === 400) {
    return { kind: code === 'DEVICE_NOT_ACTIVE' ? 'rejected' : 'refused_body', code, error };
  }

  return { kind: 'failed', code, error };
}

function describePortalError(status: number, object: Record<string, unknown> | null): string {
  const text = [object?.error, object?.message].find((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return truncate(scrubString(text ? `HTTP ${status}: ${text.trim()}` : `HTTP ${status}`));
}

/** A check-in that never got an HTTP response, described the same bounded way. */
export function describeCheckInTransportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return truncate(scrubString(message || 'request failed'));
}

function truncate(value: string): string {
  return value.length > MAX_ERROR_LENGTH ? `${value.slice(0, MAX_ERROR_LENGTH - 1)}…` : value;
}
