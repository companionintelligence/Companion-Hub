import { Body, Controller, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigurationService } from '@/core/config/configuration.service';
import {
  CONNECT_NONCE_HEADER,
  CONNECT_SIGNATURE_HEADER,
  CONNECT_TIMESTAMP_HEADER,
  verifyConnectRequest,
} from '@/modules/auth/utils/connect-request-signing';
import { AgentNotifyService } from './agent-notify.service';

const WAKE_PATH = '/api/agent-notify/wake';

@Controller('agent-notify')
export class AgentNotifyController {
  constructor(
    private readonly agentNotifyService: AgentNotifyService,
    private readonly config: ConfigurationService,
  ) {}

  /**
   * Memory rings this. We ring one app's /hooks/wake with the job id.
   * Signed with the same CI_HUB_FORWARD_AUTH_SECRET as connect exchange.
   */
  @Post('wake')
  async wake(@Req() req: Request, @Body() body: { appUrn?: string; jobId?: string }) {
    const secret = this.config.get('forwardAuthSecret');
    const verified = verifyConnectRequest(secret, {
      method: 'POST',
      path: WAKE_PATH,
      timestamp: req.get(CONNECT_TIMESTAMP_HEADER),
      nonce: req.get(CONNECT_NONCE_HEADER),
      signature: req.get(CONNECT_SIGNATURE_HEADER),
      body,
    });

    if (!verified.ok) {
      throw new UnauthorizedException(`Invalid wake signature: ${verified.reason}`);
    }

    if (!body.appUrn || !body.jobId) {
      throw new UnauthorizedException('appUrn and jobId are required');
    }

    const ok = await this.agentNotifyService.wakeApp(body.appUrn, { jobId: body.jobId });
    return { ok };
  }
}
