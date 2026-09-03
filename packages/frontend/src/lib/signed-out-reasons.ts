/** Carries "why you are back at the login screen" across a full reload. */
export const SIGNED_OUT_PARAM = 'signed_out';

/**
 * Changing a password or username revokes every session for that user, so the client has
 * to reload into a signed-out state — which throws away any toast raised beforehand. The
 * reason rides the redirect instead and the login page raises it there, where it can
 * actually be read.
 *
 * Reuses the keys the settings forms already showed, so there is nothing new to
 * translate. An unrecognised value says nothing rather than guessing.
 */
export function signedOutTranslationKey(reason: string): string | null {
  switch (reason) {
    case 'password_changed':
      return 'SETTINGS_SECURITY_PASSWORD_CHANGE_SUCCESS';
    case 'username_changed':
      return 'SETTINGS_SECURITY_CHANGE_USERNAME_SUCCESS';
    default:
      return null;
  }
}
