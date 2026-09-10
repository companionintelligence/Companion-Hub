import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const credentialsSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const verifyTotpSchema = z.object({
  totpCode: z.string(),
  totpSessionId: z.string(),
});

const changeUsernameSchema = z.object({
  newUsername: z.string(),
  password: z.string(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
});

const getTotpUriSchema = z.object({
  password: z.string(),
});

const setupTotpSchema = z.object({
  code: z.string(),
});

const disableTotpSchema = z.object({
  password: z.string(),
});

const resetPasswordSchema = z.object({
  newPassword: z.string(),
});

const passwordResetRequestSchema = z.object({
  email: z.string().email(),
  deviceId: z.string().min(1).optional(),
});

const passwordResetVerifySchema = z.object({
  token: z.string(),
});

const passwordResetCompleteSchema = z.object({
  token: z.string(),
  newPassword: z.string(),
});

const loginResponseSchema = z.object({
  success: z.boolean(),
  totpSessionId: z.string().optional(),
  sessionId: z.string().optional(),
});

const registerResponseSchema = z.object({
  success: z.boolean(),
  requiresEmailVerification: z.boolean().optional(),
});

const getTotpUriResponseSchema = z.object({
  key: z.string(),
  uri: z.string(),
});

const resetPasswordResponseSchema = z.object({
  success: z.boolean(),
  email: z.string(),
});

const checkResetPasswordRequestSchema = z.object({
  isRequestPending: z.boolean(),
});

const passwordResetRequestResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

const passwordResetVerifyResponseSchema = z.object({
  valid: z.boolean(),
  email: z.string().optional(),
});

const passwordResetCompleteResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

const portalDesktopExchangeResponseSchema = z.object({
  sessionId: z.string(),
  redirectPath: z.string(),
});

const portalSessionHintResponseSchema = z.object({
  email: z.string().nullable(),
  portalBaseUrl: z.string().nullable(),
  source: z.enum(['hub_operator', 'hub_user', 'portal_session']).nullable(),
});

const sessionRefreshResponseSchema = z.object({
  sessionId: z.string(),
  issuedAt: z.number(),
});

/**
 * Headless claim: the email the first operator is created for.
 *
 * The email is the only thing the caller supplies — the *authority* comes from the host-local
 * device key on the request, so there is no password here to be a second, weaker way in.
 */
const hubClaimSchema = z.object({
  email: z.string().trim().email(),
});

const hubClaimResponseSchema = z.object({
  claimed: z.boolean(),
  /** The operator's username (its normalized email). */
  username: z.string(),
});

const hubClaimStatusResponseSchema = z.object({
  /** At least one operator row exists, so the Hub can answer as somebody. */
  claimed: z.boolean(),
  operators: z.number(),
  /** Paired with Portal: a device registration row and an organization id are both present. */
  registered: z.boolean(),
});

const browserHandoffMintSchema = z.object({
  // Bounded so a rogue caller can't stuff a multi-KB blob into the (SQLite-backed)
  // ticket cache; legitimate Hub/app URLs are well under this.
  next: z.string().min(1).max(2048),
});

const browserHandoffMintResponseSchema = z.object({
  // null when no public Hub origin is known yet — the caller then fails open to a
  // plain external open instead of the handoff.
  url: z.string().nullable(),
});

// Login
export class LoginBody extends createZodDto(credentialsSchema) {}
export class VerifyTotpBody extends createZodDto(verifyTotpSchema) {}
export class LoginDto extends createZodDto(loginResponseSchema) {}
export class PortalDesktopExchangeDto extends createZodDto(portalDesktopExchangeResponseSchema) {}
export class PortalSessionHintDto extends createZodDto(portalSessionHintResponseSchema) {}
export class SessionRefreshDto extends createZodDto(sessionRefreshResponseSchema) {}
export class BrowserHandoffMintBody extends createZodDto(browserHandoffMintSchema) {}
export class BrowserHandoffMintDto extends createZodDto(browserHandoffMintResponseSchema) {}

// Register
export class RegisterBody extends createZodDto(credentialsSchema) {}
export class RegisterDto extends createZodDto(registerResponseSchema) {}

// Headless claim
export class HubClaimBody extends createZodDto(hubClaimSchema) {}
export class HubClaimDto extends createZodDto(hubClaimResponseSchema) {}
export class HubClaimStatusDto extends createZodDto(hubClaimStatusResponseSchema) {}

// Change username
export class ChangeUsernameBody extends createZodDto(changeUsernameSchema) {}

// Change password
export class ChangePasswordBody extends createZodDto(changePasswordSchema) {}

// TOTP
export class GetTotpUriBody extends createZodDto(getTotpUriSchema) {}
export class GetTotpUriDto extends createZodDto(getTotpUriResponseSchema) {}
export class SetupTotpBody extends createZodDto(setupTotpSchema) {}
export class DisableTotpBody extends createZodDto(disableTotpSchema) {}

// Reset password
export class ResetPasswordBody extends createZodDto(resetPasswordSchema) {}
export class ResetPasswordDto extends createZodDto(resetPasswordResponseSchema) {}
export class CheckResetPasswordRequestDto extends createZodDto(checkResetPasswordRequestSchema) {}
export class PasswordResetRequestBody extends createZodDto(passwordResetRequestSchema) {}
export class PasswordResetVerifyDto extends createZodDto(passwordResetVerifySchema) {}
export class PasswordResetCompleteBody extends createZodDto(passwordResetCompleteSchema) {}
export class PasswordResetRequestDto extends createZodDto(passwordResetRequestResponseSchema) {}
export class PasswordResetVerifyResponseDto extends createZodDto(passwordResetVerifyResponseSchema) {}
export class PasswordResetCompleteDto extends createZodDto(passwordResetCompleteResponseSchema) {}

export { passwordResetVerifyResponseSchema };
