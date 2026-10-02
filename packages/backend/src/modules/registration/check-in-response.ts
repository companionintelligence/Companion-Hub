import { describeNetworkError } from '@/common/helpers/network-error';
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

/**
 * The one coded answer the Hub acts on by clearing its own registration: Portal says this device row
 * is gone or inactive, which is what a person removing the Hub from their account in Portal produces
 * and what the Settings removal watch is waiting for. Every other 400 is a schema refusal (the Hub
 * sent a field Portal does not accept), and resetting over that would unpair a healthy Hub.
 */
export const DEVICE_NOT_ACTIVE_CODE = 'DEVICE_NOT_ACTIVE';

/** What one check-in told the Hub. */
export type CheckInOutcome =
  /** The Portal accepted the check-in. */
  | 'active'
  /** The Portal said the device was removed or deactivated, and the Hub cleared its registration. */
  | 'removed'
  /** The Portal refused the device key (a `rejected` verdict that is not `DEVICE_NOT_ACTIVE`). Nothing was reset. */
  | 'key_refused'
  /** The Portal was unreachable or answered with any other failure. */
  | 'failed'
  /**
   * Nothing to act on: no check-in was sent (the Hub is not registered, has no tunnel token, or has
   * no Portal configured), or its answer was about a registration this Hub no longer has.
   */
  | 'skipped';

/** The registration a check-in was sent for: the device key on the request, and which registration held it. */
export type CheckInRegistration = {
  deviceKey: string | null;
  /** Changes whenever this Hub's registration row is cleared or written. */
  registrationGeneration: number;
};

/**
 * True when the registration a check-in was sent for is still this Hub's registration.
 *
 * A check-in can take seconds. If the Hub is reset and paired again meanwhile, the Portal's answer
 * is about the old key: its `DEVICE_NOT_ACTIVE` says nothing about the new registration, and acting
 * on it would clear the registration that was just made.
 */
export function isCheckInForCurrentRegistration(sentFor: CheckInRegistration, current: CheckInRegistration): boolean {
  return sentFor.deviceKey === current.deviceKey && sentFor.registrationGeneration === current.registrationGeneration;
}

/** True only for the Portal's coded "this device is no longer active" answer. */
export function isDeviceNotActiveResponse(response: { status: number; data?: unknown }): boolean {
  if (response.status !== 400) {
    return false;
  }

  const body = response.data;

  return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === DEVICE_NOT_ACTIVE_CODE;
}

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
 * `rejected` covers the key refusals and `DEVICE_NOT_ACTIVE` alike: both are Portal answering about
 * this device rather than failing to answer. They differ in what the Hub does about it, not in how
 * they are read, so the caller separates them with `isDeviceNotActiveResponse` — that coded answer
 * is the only one that clears the registration.
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
    return { kind: code === DEVICE_NOT_ACTIVE_CODE ? 'rejected' : 'refused_body', code, error };
  }

  return { kind: 'failed', code, error };
}

function describePortalError(status: number, object: Record<string, unknown> | null): string {
  const text = [object?.error, object?.message].find((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return truncate(scrubString(text ? `HTTP ${status}: ${text.trim()}` : `HTTP ${status}`));
}

/**
 * A check-in that never got an HTTP response, described the same bounded way. Not by its message
 * alone: when no address of the Portal accepted the connection, that message is empty, and the
 * record said only "request failed".
 */
export function describeCheckInTransportError(error: unknown): string {
  return truncate(describeNetworkError(error));
}

function truncate(value: string): string {
  return value.length > MAX_ERROR_LENGTH ? `${value.slice(0, MAX_ERROR_LENGTH - 1)}…` : value;
}
