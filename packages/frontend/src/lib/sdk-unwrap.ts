/**
 * The text of a @hey-api error. Without the app's response interceptor (tests, the desktop probes,
 * any client built before `root.tsx` installs it) the client hands back the parsed JSON body, and
 * `String()` of that is "[object Object]" — which is what a refused model pull showed. Nest's bodies
 * carry `message` (a string, or a list from validation); Lemonade and OpenAI-style bodies `error`.
 */
export function sdkErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const body = error as { message?: unknown; error?: unknown; reason?: unknown };
    const nested = body.error as { message?: unknown } | undefined;
    const candidates = [body.message, body.reason, typeof body.error === 'string' ? body.error : nested?.message];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
      if (Array.isArray(candidate) && candidate.length > 0) return candidate.map(String).join('; ');
    }
    try {
      return JSON.stringify(error);
    } catch {
      // A body that cannot be serialised falls through to the generic text below.
    }
  }
  return String(error);
}

/** Unwrap a @hey-api client result; throws on error. */
export async function unwrapSdk<T>(promise: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const result = await promise;
  if (result.error) {
    throw result.error instanceof Error ? result.error : new Error(sdkErrorMessage(result.error));
  }
  return result.data as T;
}

/** Like unwrapSdk but returns null when the request fails. */
export async function unwrapSdkOrNull<T>(promise: Promise<{ data?: T; error?: unknown; response?: Response }>): Promise<T | null> {
  const result = await promise;
  if (result.error || !result.response?.ok) {
    return null;
  }
  return (result.data ?? null) as T | null;
}

/** Returns response status for fallback logic (e.g. dev direct Portal). */
export async function sdkResult<T>(promise: Promise<{ data?: T; error?: unknown; response?: Response }>) {
  const result = await promise;
  return {
    data: result.data as T | undefined,
    ok: Boolean(result.response?.ok),
    status: result.response?.status ?? 0,
    error: result.error,
  };
}
