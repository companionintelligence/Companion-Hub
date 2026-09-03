import type { UserDto } from '@/modules/user/dto/user.dto';

declare global {
  namespace Express {
    interface Request {
      user?: UserDto;
      /** Session id that actually authenticated this request (cookie may be stale). */
      hubSessionId?: string;
    }
  }
}
