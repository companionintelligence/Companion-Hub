/**
 * Portal's rate limits as `cihub fleet install` meets them, and how a run stays under them.
 *
 * Portal meters `POST /api/devices/pair` at ten per ten minutes per caller address: a fixed window
 * keyed on `cf-connecting-ip`, refused `429` with `Retry-After` (CI-Portal
 * `domains/core/services/rateLimit.ts`, `DEVICE_PAIR_RATE_LIMIT`). The caller is each node's Hub, not
 * this machine, and a fleet behind one NAT is one address — Portal's runbook says so of CGNAT in as
 * many words. On 2026-09-26 a from-scratch rebuild paired ten nodes back to back; core-2, core-4 and
 * core-5 then came back "Too many attempts. Try again in 51 seconds.", the run printed "Pairing
 * failed" and moved on, and the operator re-ran those nodes one at a time about 65 s apart.
 *
 * A refusal for rate is the cheapest failure a pairing can have. The limiter runs before Portal's
 * handler, so it never looked at the code: nothing is claimed, nothing to keep or replace, and the
 * same code goes again once the window has turned over.
 */

export interface PortalRateLimitRule {
  readonly windowMs: number;
  readonly max: number;
}

/**
 * CI-Portal `DEVICE_PAIR_RATE_LIMIT`: `POST /api/devices/pair`, which each node's `register` sends.
 * Mirrored, because nothing on the wire carries it until a request is refused.
 */
export const PORTAL_PAIR_RATE_LIMIT: PortalRateLimitRule = { windowMs: 10 * 60_000, max: 10 };

/** CI-Portal `DEVICE_CREATE_RATE_LIMIT`: `POST /api/devices`, the mint this machine sends per node. */
export const PORTAL_DEVICE_CREATE_RATE_LIMIT: PortalRateLimitRule = { windowMs: 10 * 60_000, max: 20 };

/** Added to every wait. Portal rounds `Retry-After` up to the second, but the retry still has to cross the network. */
export const RATE_LIMIT_MARGIN_MS = 5_000;

/**
 * How far apart a run sends its pairings by default: Portal's window over its budget, plus the margin
 * — 65 s. At that spacing at most ten land in any ten minutes, so the run cannot fill Portal's window
 * on its own.
 *
 * Ten back to back and then a pause would finish a big fleet a few minutes sooner, but only if the
 * run knew where Portal's window started. It does not: the window opened at the first pairing from
 * this address, which may have been the previous run.
 */
export const DEFAULT_PAIRING_GAP_MS = PORTAL_PAIR_RATE_LIMIT.windowMs / PORTAL_PAIR_RATE_LIMIT.max + RATE_LIMIT_MARGIN_MS;

/**
 * How many times one node waits out a refusal before it gives up. Honouring `Retry-After` should need
 * one; three covers someone else pairing from the same network in the meantime, and a bound is what
 * keeps a run that never gets through from waiting forever.
 */
export const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * The longest single wait a run sits through. Portal's limiter never asks for more than its window,
 * so a longer ask is something else — an edge rule, a block — and the node says so instead of sleeping on it.
 */
export const MAX_RATE_LIMIT_WAIT_MS = PORTAL_PAIR_RATE_LIMIT.windowMs + RATE_LIMIT_MARGIN_MS;

export interface PortalRateLimit {
  /** What Portal advertised, when the answer carried it. */
  retryAfterSeconds?: number;
  /** The words that said so, quoted on the node's line. */
  said: string;
}

/** Portal refused a request for rate. Nothing was created or spent, so the same request can be sent again. */
export class PortalRateLimitedError extends Error {
  constructor(
    readonly limit: PortalRateLimit,
    message: string,
  ) {
    super(message);
    this.name = 'PortalRateLimitedError';
  }
}

export function portalRateLimitOf(error: unknown): PortalRateLimit | undefined {
  return error instanceof PortalRateLimitedError ? error.limit : undefined;
}

/** `Retry-After` in seconds: a delta, which is what Portal sends, or an HTTP date. */
export function retryAfterSecondsFrom(headers: Pick<Headers, 'get'>, now = Date.now()): number | undefined {
  const raw = headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

/**
 * Whether a node's `hub up + register` output is Portal refusing the pair for rate.
 *
 * The node's Hub turns Portal's `429` into `Too many attempts. Try again in N seconds.`, or `…Please
 * wait a moment and try again.` when there was no `Retry-After` (`rateLimitedWaitCopy`, backend
 * `common/helpers/retry-after.ts`), and `cihub register` prints it in its `Pairing failed` box. A
 * Hub older than that copy (2026-08-24) passed Portal's own body through, `Too many requests`, and
 * that one counts only inside the `Pairing failed` box: Docker Hub's pull limit says "Too Many
 * Requests" during the `cihub up` in front of it, and a code that never reached Portal is not
 * waiting on Portal.
 */
export function detectPairingRateLimit(output: string): PortalRateLimit | undefined {
  const text = output.replace(/\s+/g, ' ');
  // Printed only once Portal has taken the code; whatever failed after it was not the limiter.
  if (/Pairing accepted/i.test(text)) return undefined;
  const hub = /Too many attempts\.?(?: Try again in (\d+) seconds?\.?| Please wait a moment and try again\.?)?/i.exec(text);
  if (hub) return { said: hub[0].trim(), ...(hub[1] ? { retryAfterSeconds: Number(hub[1]) } : {}) };
  const passedThrough = /Pairing failed\W+(Too many requests|Pairing failed: HTTP 429)/i.exec(text);
  return passedThrough?.[1] ? { said: passedThrough[1] } : undefined;
}

/**
 * How long to wait before asking again, or `undefined` when Portal asked for longer than
 * `MAX_RATE_LIMIT_WAIT_MS`. Without a `Retry-After` the default pairing gap stands in: the window
 * could have anything up to ten minutes left, and bounded retries of a minute each find out.
 */
export function rateLimitWaitMs(limit: Pick<PortalRateLimit, 'retryAfterSeconds'>): number | undefined {
  if (limit.retryAfterSeconds === undefined) return DEFAULT_PAIRING_GAP_MS;
  const ms = limit.retryAfterSeconds * 1000 + RATE_LIMIT_MARGIN_MS;
  return ms <= MAX_RATE_LIMIT_WAIT_MS ? ms : undefined;
}

export function describeWait(ms: number): string {
  return `${Math.ceil(ms / 1000)}s`;
}

/** Why a node's pairing waited for the pacer — the same words live and in the report. */
export function describePairingPace(gapMs: number): string {
  const { windowMs, max } = PORTAL_PAIR_RATE_LIMIT;
  return `Portal allows ${max} pairings per ${windowMs / 60_000} minutes from one network address, so this run sends them ${describeWait(gapMs)} apart (--pairing-gap)`;
}

export interface PacerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: PacerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Spaces one run's pairings and holds them while Portal says to wait.
 *
 * One per run, shared by every node, because Portal counts per address and the nodes share one.
 * `fleet install` is serialised per node, so spacing consecutive pairings is the whole job: the gap
 * runs from the END of one node's `hub up + register` to the START of the next, since the pair call
 * happens somewhere inside that step and the ends are the only instants this side knows bound it.
 */
export class PairingPacer {
  private lastRedeemAt: number | undefined;
  private heldUntil = 0;

  constructor(
    readonly gapMs: number = DEFAULT_PAIRING_GAP_MS,
    private readonly clock: PacerClock = realClock,
  ) {}

  /** How long, from now, the next pairing has to wait. */
  dueInMs(): number {
    const now = this.clock.now();
    const byGap = this.lastRedeemAt === undefined ? now : this.lastRedeemAt + this.gapMs;
    return Math.max(0, byGap - now, this.heldUntil - now);
  }

  /** Wait until the next pairing may go out; returns how long that was. */
  async waitTurn(): Promise<number> {
    const ms = this.dueInMs();
    if (ms > 0) await this.clock.sleep(ms);
    return ms;
  }

  /**
   * A pairing step just ended, and Portal counted whatever it sent. Called for every outcome but a
   * refusal for rate — the one answer Portal does not count — including a step that died before it
   * paired, since from here the two look alike and waiting for nothing only costs time.
   */
  redeemed(): void {
    this.lastRedeemAt = this.clock.now();
  }

  /** Portal said to wait: nothing from this address pairs for `ms`, whichever node is next. */
  holdFor(ms: number): void {
    this.heldUntil = Math.max(this.heldUntil, this.clock.now() + ms);
  }

  /** A wait that is not about pairing — a mint Portal refused for rate — on the same clock. */
  pause(ms: number): Promise<void> {
    return this.clock.sleep(ms);
  }
}
