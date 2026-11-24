/**
 * The short description the Hub writes into a new custom app's manifest. Screens leave it out: the
 * page already says what kind of app it is, and guests saw "User-created custom app" on every tile.
 */
export const CUSTOM_APP_DEFAULT_SHORT_DESC = 'User-created custom app';

/** The same for a port expose. */
export const PORT_EXPOSE_DEFAULT_SHORT_DESC = 'User workload exposed on a host port';

/** True for a short description the Hub wrote itself, which says nothing about the app. */
export function isLocalAppDefaultShortDesc(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return trimmed === CUSTOM_APP_DEFAULT_SHORT_DESC || trimmed === PORT_EXPOSE_DEFAULT_SHORT_DESC;
}
