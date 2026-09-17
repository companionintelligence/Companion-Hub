import { type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from './auth.guard';

export const OBSERVABILITY_READ_METADATA = 'ci-hub:observability-read';

export interface ObservabilityReadOptions {
  /**
   * Also admit the CLI JWT on a Hub nobody has claimed yet. See {@link ObservabilityReadGuard} for
   * why this is safe, and why it is the CLI JWT and not the Portal device key.
   */
  unclaimedCli?: boolean;
}

/**
 * Mark a GET handler as readable by a `qa:read` API key (and, with `unclaimedCli`, by the CLI JWT on
 * an unclaimed Hub). Pair it with `@UseGuards(ObservabilityReadGuard)` in place of `AuthGuard`.
 *
 * The marker is the allow-list. A GET route without it refuses a `qa:read` key with 403 in `AuthGuard`,
 * so adding a new operator route can never widen what a test key reaches by accident — only putting
 * this decorator on it can, and a test pins the exact set of handlers that carry it.
 *
 * Only for handlers that read. The guard also refuses anything but GET/HEAD, but a GET that changes
 * state (there are a few in this codebase, such as probes that start work) must not carry it either.
 * It has no effect under a class-level `@UseGuards(AuthGuard)`: that guard runs first and refuses.
 */
export const ObservabilityRead = (options: ObservabilityReadOptions = {}) => SetMetadata(OBSERVABILITY_READ_METADATA, options);

/**
 * The methods the admissions below apply to. HEAD reaches a GET handler in Express, and reads exactly
 * as much. Exported because `AuthMiddleware` resolves a `qa:read` key only on these, and the two must
 * not drift: a method admitted here but not looked up there would be a key that silently never works.
 */
export const OBSERVABILITY_READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * `AuthGuard`, plus two narrow admissions on handlers marked `@ObservabilityRead()`.
 *
 * Everything `AuthGuard` admits is still admitted here unchanged, and everything it refuses is refused
 * with the same answer — the admissions below are checked only for a request that has no `user`, and
 * only fall through to `AuthGuard` when neither applies.
 *
 * 1. A `qa:read` API key (`hubPrincipal === 'qa-read'`), on any marked GET.
 *
 * 2. `unclaimedCli`: the CLI JWT on a Hub with no operator row (`hubUnclaimed`), on the marked GETs
 *    that opt in — today pool status and the routing log.
 *
 *    Measured on the fleet 2026-09-17: core-2 is registered but unclaimed, and the only credential on
 *    it is a CLI JWT. `AuthGuard` answers that JWT 409 AUTH_ERROR_HUB_NOT_CLAIMED on every route, so
 *    which node served a pooled request could not be measured on that node at all — its routing log
 *    was unreadable to everyone.
 *
 *    Why this does not weaken anything:
 *    - The JWT is signed with `jwtSecret`, which lives in the Hub's state file beside the device key
 *      (see `AuthMiddleware`). Presenting one proves read access to the Hub's own state on the host —
 *      the access `cihub` itself runs with, and `cihub` already writes `api_key` rows straight into
 *      the database over `docker exec psql` (see `scripts/lib/cli-api-key.ts`). Pool status and
 *      routing metadata are strictly less than that holder can already reach.
 *    - The unclaimed refusal exists because there is no operator for a host-local credential to SPEAK
 *      AS: it keeps the credential from acting, installing or configuring as a person who does not
 *      exist. Reading two metadata routes acts as nobody, so the reason for the refusal does not reach
 *      them. Every other route, including every write, still answers 409.
 *    - A claimed Hub is untouched: there the JWT already has a `user` (the first operator) and passes
 *      `AuthGuard` as before, and `hubUnclaimed` is never set.
 *    - Not the Portal device key, although it is host-local in the same file: Portal holds that key
 *      too, off the host. On a Hub nobody has claimed, nobody has agreed to let a credential known to
 *      the cloud read the pool's topology, so it keeps its 409 until someone claims the Hub.
 */
@Injectable()
export class ObservabilityReadGuard extends AuthGuard {
  constructor(
    logger: LoggerService,
    private readonly reflector: Reflector,
  ) {
    super(logger);
  }

  override async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest() as Request;
    const options = this.reflector.get<ObservabilityReadOptions | undefined>(OBSERVABILITY_READ_METADATA, context.getHandler());

    if (options && !request.user && OBSERVABILITY_READ_METHODS.has(request.method)) {
      if (request.hubPrincipal === 'qa-read') {
        return true;
      }
      if (options.unclaimedCli && request.hubUnclaimed && request.hubPrincipal === 'cli') {
        return true;
      }
    }

    return super.canActivate(context);
  }
}
