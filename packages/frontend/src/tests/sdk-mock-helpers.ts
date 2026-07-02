/** Helpers for mocking @hey-api / sdk.gen results consumed by sdkResult(). */
export function sdkOk<T>(data: T, status = 200) {
  return {
    data,
    response: new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  };
}

export function sdkFail(status: number, data?: unknown) {
  return {
    data,
    response: new Response(data ? JSON.stringify(data) : null, { status }),
    error: new Error(`HTTP ${status}`),
  };
}
