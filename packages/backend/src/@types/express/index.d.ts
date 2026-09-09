import type { UserDto } from '@/modules/user/dto/user.dto';

declare global {
  namespace Express {
    interface Request {
      user?: UserDto;
      /** Session id that actually authenticated this request (cookie may be stale). */
      hubSessionId?: string;
      /**
       * Which authentication arm answered, and therefore what kind of caller this
       * is. Every arm of `AuthMiddleware` sets it.
       *
       * The grant gate reads this, and absence is a refusal: it used to exempt any
       * request without a `hubSessionId`, which widened silently as arms were added.
       * See `isGrantExemptPrincipal` in `hub-session-operator.ts`.
       */
      hubPrincipal?: 'session' | 'portal-device' | 'cli';
    }
  }
}
