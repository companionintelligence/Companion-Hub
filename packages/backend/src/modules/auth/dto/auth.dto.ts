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

const loginResponseSchema = z.object({
  success: z.boolean(),
  totpSessionId: z.string().optional(),
  sessionId: z.string().optional(),
});

const registerResponseSchema = z.object({
  success: z.boolean(),
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

const portalDesktopExchangeResponseSchema = z.object({
  sessionId: z.string(),
  redirectPath: z.string(),
});

// Login
export class LoginBody extends createZodDto(credentialsSchema) {}
export class VerifyTotpBody extends createZodDto(verifyTotpSchema) {}
export class LoginDto extends createZodDto(loginResponseSchema) {}
export class PortalDesktopExchangeDto extends createZodDto(portalDesktopExchangeResponseSchema) {}

// Register
export class RegisterBody extends createZodDto(credentialsSchema) {}
export class RegisterDto extends createZodDto(registerResponseSchema) {}

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
