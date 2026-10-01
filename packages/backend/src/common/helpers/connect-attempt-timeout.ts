import net from 'node:net';

/**
 * How long Node gives each of a host's addresses to accept a connection before it tries the next one.
 *
 * Node connects to a name's addresses one at a time, alternating IPv4 and IPv6, and gives each
 * attempt 250 ms by default. An attempt that runs out of time is closed, not left running beside
 * the next, so a link whose TCP handshake takes longer than that cannot connect at all: a satellite
 * or busy mobile link, a distant VPN exit, or one lost SYN, which Linux sends again after 1 s.
 * Every attempt ends in ETIMEDOUT, and the request fails within a second, exactly as it does when
 * the network is down. Measured with Node 22 in a container without IPv6, like the Hub's: with
 * 300 ms of added latency a Portal request failed in 0.8 s, and with 2 s per attempt it succeeded
 * in 1.4 s.
 *
 * 2 s allows a handshake of up to 2 s, or one resent SYN on a link with a round trip under 1 s.
 * The cost is paid only for an address that never answers, which now holds up the next one for 2 s
 * instead of 250 ms. In the Hub's container an IPv6 address fails at once, as there is no route,
 * so only IPv4 addresses wait. For a name with two of them, as the Portal has, that is 4 s, still
 * inside the 5 s check-in timeout, so a failed check-in still names each address that failed.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2_000;

/**
 * Sets {@link CONNECT_ATTEMPT_TIMEOUT_MS} as Node's default. Node reads the default each time a
 * socket connects, so it covers axios and any other client that does not pass a value of its own.
 */
export function raiseConnectAttemptTimeout(): void {
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
}
