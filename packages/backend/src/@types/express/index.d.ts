import type { UserDto } from '@/modules/user/dto/user.dto';

declare global {
  namespace Express {
    interface Request {
      user?: UserDto;
      /** Session id that actually authenticated this request (cookie may be stale). */
      hubSessionId?: string;
      /**
       * WHICH AUTHENTICATION ARM ANSWERED, and therefore what kind of caller
       * this is. Every arm of `AuthMiddleware` sets it.
       *
       * ⚠ THE GRANT GATE READS THIS, AND ABSENCE IS A REFUSAL. The org-grant
       * checks used to exempt any request without a `hubSessionId`, which is
       * true of the Portal-device bearer AND of the CLI JWT AND of any future
       * arm that forgets to set a session — so the exemption widened silently
       * every time an arm was added. Naming the principal makes the exemption a
       * decision rather than a side effect: see `hub-session-operator.ts`.
       */
      hubPrincipal?: 'session' | 'portal-device' | 'cli';
    }
  }
}
