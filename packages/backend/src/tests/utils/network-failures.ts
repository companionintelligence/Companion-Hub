/**
 * A request that failed on every address of the Portal, shaped as Node 22 and axios 1.20 build it.
 *
 * Built by hand rather than with `AxiosError.from`, because many suites mock axios whole.
 * `network-error.test.ts` checks this shape against the real `AxiosError.from` — that check is
 * what caught axios 1.20 changing the shape, so keep it passing rather than relaxing it.
 */

const ERRNO = { ETIMEDOUT: -110, ENETUNREACH: -101, ECONNREFUSED: -111 } as const;

/** One failed connection attempt, as Node's `net` builds it: the message repeats the fields. */
export function connectFailure(code: keyof typeof ERRNO, address: string, port = 443) {
  return Object.assign(new Error(`connect ${code} ${address}:${port}`), { errno: ERRNO[code], code, syscall: 'connect', address, port });
}

/**
 * What Node throws when no address of a name accepted the connection: an empty message, the first
 * attempt's code, and every attempt in `errors`. This is the Hub's case without IPv6 in its
 * container: each IPv4 address runs out of time and each IPv6 one has no route.
 */
export function everyAddressFailed() {
  const attempts = [
    connectFailure('ETIMEDOUT', '192.0.2.10'),
    connectFailure('ENETUNREACH', '2001:db8::10'),
    connectFailure('ETIMEDOUT', '198.51.100.7'),
    connectFailure('ENETUNREACH', '2001:db8::11'),
  ];

  return Object.assign(new AggregateError(attempts, ''), { code: 'ETIMEDOUT' });
}

/**
 * {@link everyAddressFailed} as axios rejects with it: name and code copied, the attempts on
 * `cause`, and a message axios synthesises by joining the attempts with `'; '`.
 *
 * Up to axios 1.18 this message was the AggregateError's own empty string. 1.20 populates it
 * instead, so it is derived from `cause.errors` here rather than hard-coded — that keeps the
 * fixture byte-identical to `AxiosError.from` even if the attempt list above changes.
 *
 * Consumers assert on {@link EVERY_ADDRESS_FAILED} (what `describeNetworkError` returns from
 * `cause.errors`), never on this message, so populating it changes no expectations.
 */
export function axiosEveryAddressFailed() {
  const cause = everyAddressFailed();
  const message = cause.errors.map((attempt: Error) => attempt.message).join('; ');

  return Object.assign(new Error(message), { name: cause.name, isAxiosError: true as const, code: cause.code, cause });
}

/** How the Hub describes those four attempts. */
export const EVERY_ADDRESS_FAILED =
  'ETIMEDOUT 192.0.2.10:443, ENETUNREACH [2001:db8::10]:443, ETIMEDOUT 198.51.100.7:443, ENETUNREACH [2001:db8::11]:443';
