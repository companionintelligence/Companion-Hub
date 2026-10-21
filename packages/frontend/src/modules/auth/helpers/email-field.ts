import type { TFunction } from 'i18next';
import { z } from 'zod';

/**
 * The email field of the sign-in, sign-up and reset-password forms. Zod's own messages ("Invalid
 * email address") are English only, so an empty field and a malformed address each get a
 * translated one. A malformed address reads as it does in the Change username dialog.
 */
export const emailField = (t: TFunction) =>
  z.string().trim().min(1, t('AUTH_FORM_ERROR_EMAIL_REQUIRED')).email(t('SETTINGS_SECURITY_CHANGE_USERNAME_FORM_INVALID_USERNAME'));
