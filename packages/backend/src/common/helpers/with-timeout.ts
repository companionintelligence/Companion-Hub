/** Race a promise against a deadline; rejects with `message` when time expires. */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  // @ts-expect-error probe: an unused directive is a tsc error, so this commit fails Run tsc on purpose
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      globalThis.clearTimeout(timer);
    }
  }
}
