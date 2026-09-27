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
 *
 * The same limiter has one other answer that comes before the handler. The pair route is
 * `failClosed`, so when the limiter cannot reach its D1 counter it refuses rather than let an
 * unmetered code guess through: `503 {"error":"Service temporarily unavailable"}` with
 * `Retry-After: 5` (CI-Portal `domains/core/middleware/rateLimit.ts`,
 * `LIMITER_UNAVAILABLE_RETRY_SECONDS`). Nothing was counted and the code was never looked at, so it
 * is the same kind of answer with a much shorter wait.
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

/**
 * CI-Portal `LIMITER_UNAVAILABLE_RETRY_SECONDS`: the `Retry-After` on the limiter's fail-closed 503.
 * Mirrored because the node's Hub relays `Retry-After` only on a 429, so the seconds never reach the
 * node's output.
 */
export const LIMITER_UNAVAILABLE_RETRY_SECONDS = 5;

/**
 * How many nodes in a row may give up on Portal refusing them before it looked at their codes
 * before the run stops pairing. Each such node has already waited up to three times, up to ten
 * minutes each, so a run that kept going would spend about half an hour per remaining node learning
 * the same thing: something else on this network is keeping the address's budget spent. One node
 * can be unlucky; two in a row is the network.
 */
export const MAX_REFUSED_NODES_IN_A_ROW = 2;

export interface PortalRateLimit {
  /** What Portal advertised, when the answer carried it. */
  retryAfterSeconds?: number;
  /** The words that said so, quoted on the node's line. */
  said: string;
  /**
   * The limiter could not reach its counter and refused anyway (the pair route fails closed), rather
   * than the address having spent its budget. Nothing was counted, and the wait is seconds.
   */
  limiterUnavailable?: true;
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
 *
 * The limiter's fail-closed 503 reaches the node the way every other non-429 does: the Hub passes
 * Portal's `error` through, so the box reads `Service temporarily unavailable`, without the five
 * seconds. Nothing in Portal's pair handler says those words (its own 503s say "Could not … Try
 * again." and carry a `code`), and nothing in the Hub does, so inside the `Pairing failed` box they
 * are the limiter and only the limiter.
 */
export function detectPairingRateLimit(output: string): PortalRateLimit | undefined {
  const text = output.replace(/\s+/g, ' ');
  // Printed only once Portal has taken the code; whatever failed after it was not the limiter.
  if (/Pairing accepted/i.test(text)) return undefined;
  const hub = /Too many attempts\.?(?: Try again in (\d+) seconds?\.?| Please wait a moment and try again\.?)?/i.exec(text);
  if (hub) return { said: hub[0].trim(), ...(hub[1] ? { retryAfterSeconds: Number(hub[1]) } : {}) };
  const limiterDown = /Pairing failed\W+(Service temporarily unavailable)/i.exec(text);
  if (limiterDown?.[1]) return { said: limiterDown[1], retryAfterSeconds: LIMITER_UNAVAILABLE_RETRY_SECONDS, limiterUnavailable: true };
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
 * Spaces one run's pairings, holds them while Portal says to wait, and says when to stop.
 *
 * One per run, shared by every node, because Portal counts per address and the nodes share one. The
 * gap runs from the END of one node's `hub up + register` to the START of the next, since the pair
 * call happens somewhere inside that step and the ends are the only instants this side knows bound it.
 *
 * A pairing holds the turn from `waitTurn` until it ends — `redeemed()` when Portal counted it,
 * `notCounted()` when Portal refused it first — and a second caller queues behind it rather than
 * reading the same "due now" and going out alongside. `fleet install` is serialised per node, so
 * today there is never a second caller; the queue is what keeps that an assumption the pacer does
 * not need. It does not reach across processes: two `fleet install` runs against one fleet each pace
 * themselves, and between them rest on the bounded retry of a refusal.
 */
export class PairingPacer {
  private lastRedeemAt: number | undefined;
  private heldUntil = 0;
  /** Settles when the pairing that holds the turn has ended; the next `waitTurn` queues on it. */
  private turn: Promise<void> = Promise.resolve();
  private endTurn: (() => void) | undefined;
  private refusedInARow: string[] = [];

  constructor(
    readonly gapMs: number = DEFAULT_PAIRING_GAP_MS,
    private readonly clock: PacerClock = realClock,
  ) {}

  /** How long, from now, the gap and any hold make the next pairing wait; a pairing in flight comes on top. */
  dueInMs(): number {
    const now = this.clock.now();
    const byGap = this.lastRedeemAt === undefined ? now : this.lastRedeemAt + this.gapMs;
    return Math.max(0, byGap - now, this.heldUntil - now);
  }

  /**
   * Take the turn: queue behind any pairing in flight, then wait out the gap or a hold. Returns that
   * last wait, which `onWait` hears just before it starts, so a line printed from it names the wait
   * that follows and not one read before the queue moved. The caller holds the turn until it calls
   * `redeemed()` or `notCounted()`, and must call one of them.
   */
  async waitTurn(onWait?: (ms: number) => void): Promise<number> {
    const ahead = this.turn;
    let end: (() => void) | undefined;
    this.turn = new Promise<void>((resolve) => {
      end = resolve;
    });
    await ahead;
    this.endTurn = end;
    const ms = this.dueInMs();
    if (ms > 0) {
      onWait?.(ms);
      await this.clock.sleep(ms);
    }
    return ms;
  }

  /**
   * A pairing step just ended, and Portal counted whatever it sent. Called for every outcome but a
   * refusal before the handler — the answers Portal does not count — including a step that died
   * before it paired, since from here the two look alike and waiting for nothing only costs time.
   * `registered` is the one outcome that proves Portal is letting pairings through again, so only it
   * clears the nodes refused in a row.
   */
  redeemed(outcome: { registered?: boolean } = {}): void {
    this.lastRedeemAt = this.clock.now();
    if (outcome.registered) this.refusedInARow = [];
    this.finishTurn();
  }

  /**
   * Portal refused this turn's pairing before it counted it — for rate, or because its limiter was
   * down — so the gap does not restart from it. Ends the turn; `holdMs`, when given, holds every
   * node, this one's own retry included, for what Portal asked.
   */
  notCounted(holdMs?: number): void {
    if (holdMs !== undefined) this.holdFor(holdMs);
    this.finishTurn();
  }

  /** Portal said to wait: nothing from this address pairs for `ms`, whichever node is next. */
  holdFor(ms: number): void {
    this.heldUntil = Math.max(this.heldUntil, this.clock.now() + ms);
  }

  /** A wait that is not about pairing — a mint Portal refused for rate — on the same clock. */
  pause(ms: number): Promise<void> {
    return this.clock.sleep(ms);
  }

  /**
   * A node stopped because Portal kept refusing it before it looked at the code: out of waits, or
   * asked for longer than Portal's own window. Counted until a node registers.
   */
  gaveUp(node: string): void {
    this.refusedInARow.push(node);
  }

  /**
   * Why the run should pair no further, once `MAX_REFUSED_NODES_IN_A_ROW` nodes in a row have given
   * up; `undefined` until then. Without it a run whose every pairing is refused visited every node
   * before it reported anything: about half an hour of waiting apiece, nine hours or more for
   * seventeen, to learn on the last node what the second had already shown.
   */
  stopReason(): string | undefined {
    if (this.refusedInARow.length < MAX_REFUSED_NODES_IN_A_ROW) return undefined;
    return `Portal kept refusing ${this.refusedInARow.join(', ')}, one after the other, before it looked at their codes, for longer than this run waits`;
  }

  private finishTurn(): void {
    const end = this.endTurn;
    this.endTurn = undefined;
    end?.();
  }
}
