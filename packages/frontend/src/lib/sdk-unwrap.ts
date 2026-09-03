/** Unwrap a @hey-api client result; throws on error. */
export async function unwrapSdk<T>(promise: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const result = await promise;
  if (result.error) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
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
