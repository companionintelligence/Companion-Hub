import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isIP } from 'node:net';

function normalizeClientIp(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

function isPrivateOrLocalClient(ip: string): boolean {
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (!isIP(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b = -1] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Allow requests from loopback and RFC1918 Docker/LAN clients only. */
@Injectable()
export class InternalNetworkGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest() as Request;
    const forwarded = request.headers['x-forwarded-for'];
    const candidate = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
    const ip = normalizeClientIp(candidate ?? request.ip ?? request.socket.remoteAddress ?? undefined);
    if (!ip || !isPrivateOrLocalClient(ip)) {
      throw new ForbiddenException('This endpoint is only available on the local appliance network');
    }
    return true;
  }
}
