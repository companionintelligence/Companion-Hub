import { Body, Controller, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsReadService } from '@/modules/apps/apps-read.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { memoryConnectSecret } from '@/modules/memory-connect/memory-connect-secret';
import { isMemoryProviderApp } from '@/modules/memory-connect/memory-provider.predicate';
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
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Memory rings this. We ring one app's /hooks/wake with the job id.
   *
   * Signed with the installed Companion Memory's own connect key (`memoryConnectSecret`), the key
   * the Hub signs its connect calls to that Memory with. It used to be the Hub-wide secret, which
   * env generation copied into Memory: anything that reached inside a Memory container could ring
   * this as the Hub's own trusted caller.
   */
  @Post('wake')
  async wake(@Req() req: Request, @Body() body: { appUrn?: string; jobId?: string }) {
    const parts = {
      method: 'POST',
      path: WAKE_PATH,
      timestamp: req.get(CONNECT_TIMESTAMP_HEADER),
      nonce: req.get(CONNECT_NONCE_HEADER),
      signature: req.get(CONNECT_SIGNATURE_HEADER),
      body,
    };
    const secrets = await this.memoryConnectSecrets();
    const results = secrets.map((secret) => verifyConnectRequest(secret, parts));

    if (!results.some((result) => result.ok)) {
      const reason = results[0] && !results[0].ok ? results[0].reason : 'no Companion Memory with a connect key';
      throw new UnauthorizedException(`Invalid wake signature: ${reason}`);
    }

    if (!body.appUrn || !body.jobId) {
      throw new UnauthorizedException('appUrn and jobId are required');
    }

    const ok = await this.agentNotifyService.wakeApp(body.appUrn, { jobId: body.jobId });
    return { ok };
  }

  /** The connect key of every installed official Companion Memory (normally one). */
  private async memoryConnectSecrets(): Promise<string[]> {
    // Database rows only: a doorbell needs no compose files read.
    const installed = await this.moduleRef.get(AppsReadService, { strict: false }).getInstalledAppsLite();
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const envUtils = this.moduleRef.get(EnvUtils, { strict: false });
    const hubWide = this.config.get('forwardAuthSecret');
    const secrets = await Promise.all(
      installed
        .map((app) => createAppUrn(app.appName, app.appStoreSlug))
        .filter((urn) => isMemoryProviderApp({ urn }))
        .map((urn) => memoryConnectSecret(appFilesManager, envUtils, hubWide, urn)),
    );

    return secrets.filter((secret): secret is string => secret != null);
  }
}
