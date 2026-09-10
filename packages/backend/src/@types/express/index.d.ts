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
      /**
       * A host-local credential (device key or CLI JWT) authenticated, but this Hub has no
       * operator row for it to speak as — it was registered with Portal and never claimed.
       *
       * Set INSTEAD of `user`, never alongside it: the middleware used to assign the missing
       * operator to `req.user` anyway, so `AuthGuard` answered every pooled request with
       * "you must be logged in" and the whole fleet was diagnosed as having bad device keys.
       * See `AuthGuard` and `POST /api/auth/hub/claim`.
       */
      hubUnclaimed?: boolean;
    }
  }
}
