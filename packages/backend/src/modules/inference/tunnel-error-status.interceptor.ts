import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { TUNNEL_MARKER_HEADERS } from '@/common/helpers/hub-pool';

/** Statuses Cloudflare's edge answers with its own text (`error code: 502`) in place of the origin's body. */
const STATUSES_CLOUDFLARE_REPLACES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Keeps the Hub's own error body on an inference reply that leaves through the Cloudflare tunnel.
 *
 * A client on the public address that asked for a model no node has, or an image backend that isn't
 * there, got Cloudflare's plain-text `error code: 502` with the Hub's explanation gone (#2274). Such a
 * reply goes out as 500 instead, which Cloudflare passes through and an OpenAI SDK retries like a 502.
 * Requests from inside the machine, the LAN or the tailnet carry no tunnel marker and keep the real status.
 */
@Injectable()
export class TunnelErrorStatusInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    if (TUNNEL_MARKER_HEADERS.some((header) => req.headers[header] !== undefined)) {
      const setStatus = res.status.bind(res);
      res.status = (code: number) => setStatus(STATUSES_CLOUDFLARE_REPLACES.has(code) ? 500 : code);
    }

    return next.handle();
  }
}
