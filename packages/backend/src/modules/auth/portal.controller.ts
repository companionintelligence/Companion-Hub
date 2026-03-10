import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LoggerService } from '@/core/logger/logger.service';

@Controller('auth')
export class PortalController {
  constructor(private readonly logger: LoggerService) {}

  @Get('/portal')
  async portal(@Req() req: Request, @Res() res: Response) {
    // If user not authenticated, reuse existing /login redirect behaviour
    if (!req.user) {
      const host = req.headers['x-forwarded-host'] as string | undefined;
      const proto = req.headers['x-forwarded-proto'] as string | undefined;
      const uri = req.headers['x-forwarded-uri'] as string | undefined;

      const redirectTarget = req.query.redirect || uri || '/';

      const rootDomain = host ? host.split('.').slice(1).join('.') : undefined;

      if (rootDomain && proto) {
        const loginUrl = new URL('/login', `${proto}://${rootDomain}`);
        if (typeof redirectTarget === 'string') loginUrl.searchParams.set('redirect_url', redirectTarget);
        if (typeof req.query.app === 'string') loginUrl.searchParams.set('app', req.query.app);
        this.logger.debug('Portal redirecting to login', { loginUrl: loginUrl.toString() });
        return res.status(302).redirect(loginUrl.toString());
      }

      return res.status(302).redirect('/login');
    }

    // Minimal portal page that just redirects to app URL
    const redirect = (req.query.redirect as string) || '/';

    // Render a minimal HTML page with spinner + JS redirect to ensure cookies/same-site are respected
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening...</title><style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui,Arial;color:#444} .spinner{width:48px;height:48px;border-radius:50%;border:6px solid #eee;border-top-color:#6366f1;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div><div class="spinner" aria-hidden="true"></div><p style="text-align:center;margin-top:12px">Opening...</p></div><script>try{window.location.replace(${JSON.stringify(redirect)})}catch(e){window.location.href=${JSON.stringify(redirect)}}</script></body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  }
}
