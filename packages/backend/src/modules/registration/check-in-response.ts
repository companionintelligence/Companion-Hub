/**
 * How the Hub reads Companion Portal's answer to `POST /api/devices/check-in`.
 *
 * Only one answer clears the local registration: a 400 whose body carries `code: 'DEVICE_NOT_ACTIVE'`.
 * The Portal sends it for a device it deleted or marked inactive. A 400 without that code is a
 * schema refusal (the Hub sent a field the Portal does not accept), and resetting over that would
 * unpair a healthy Hub. Every other device-key failure (401, 403) stays a failure, never a removal.
 */
export const DEVICE_NOT_ACTIVE_CODE = 'DEVICE_NOT_ACTIVE';

/** What one check-in told the Hub. */
export type CheckInOutcome =
  /** The Portal accepted the check-in. */
  | 'active'
  /** The Portal said the device was removed or deactivated, and the Hub cleared its registration. */
  | 'removed'
  /** The Portal refused the device key (401 or 403). Nothing was reset. */
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

/** A 401 or 403: the Portal does not accept this device key for this device. */
export function isDeviceKeyRefusedStatus(status: number): boolean {
  return status === 401 || status === 403;
}
