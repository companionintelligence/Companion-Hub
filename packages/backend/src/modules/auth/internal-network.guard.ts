import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isPrivateOrLocalIp, normalizeIpLiteral } from '@/common/helpers/ip-address';

/** Allow requests from loopback and RFC1918 Docker/LAN clients only. */
@Injectable()
export class InternalNetworkGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest() as Request;
    const ip = normalizeIpLiteral(request.ip ?? request.socket.remoteAddress ?? undefined);
    if (!ip || !isPrivateOrLocalIp(ip)) {
      throw new ForbiddenException('This endpoint is only available on the local appliance network');
    }
    return true;
  }
}
