import { completePasswordReset, requestPasswordReset, verifyPasswordResetToken } from '@/api-client/sdk.gen';
import { sdkResult } from '@/lib/sdk-unwrap';

export async function verifyResetPasswordToken(token: string): Promise<boolean> {
  const result = await sdkResult(
    verifyPasswordResetToken({
      path: { token },
    } as Parameters<typeof verifyPasswordResetToken>[0]),
  );
  if (!result.ok) return false;
  const body = (result.data ?? {}) as { valid?: boolean };
  return body.valid === true;
}

export async function requestResetPassword(email: string): Promise<{ ok: boolean; message?: string }> {
  const result = await sdkResult(
    requestPasswordReset({
      body: { email },
    } as Parameters<typeof requestPasswordReset>[0]),
  );
  if (result.ok) return { ok: true };
  const body = (result.data ?? {}) as { message?: string };
  return { ok: false, message: body.message };
}

export async function completeResetPassword(token: string, newPassword: string): Promise<{ ok: boolean; message?: string }> {
  const result = await sdkResult(
    completePasswordReset({
      body: { token, newPassword },
    } as Parameters<typeof completePasswordReset>[0]),
  );
  if (result.ok) return { ok: true };
  const body = (result.data ?? {}) as { message?: string };
  return { ok: false, message: body.message };
}
