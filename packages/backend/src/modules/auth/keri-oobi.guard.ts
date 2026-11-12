import { type CanActivate, type ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';

export const KERI_OOBI_FLAG = 'CI_HUB_KERI_OOBI';

export function absentOobiRoute(request: Request): NotFoundException {
  return new NotFoundException(`Cannot ${request.method} ${request.originalUrl}`);
}

@Injectable()
export class KeriOobiFlagGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (process.env[KERI_OOBI_FLAG] === 'true') {
      return true;
    }

    throw absentOobiRoute(context.switchToHttp().getRequest<Request>());
  }
}
