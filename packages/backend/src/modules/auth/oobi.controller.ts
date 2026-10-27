import { createOobiDiscoveryResponse } from '@ci-hub/common/keri';
import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ForwardAuthIdentityResolver } from './forward-auth-identity.resolver';

@ApiTags('KERI / Trust Over IP')
@Controller()
export class OobiController {
  constructor(private readonly forwardAuthResolver: ForwardAuthIdentityResolver) {}

  @Get('.well-known/keri/oobi')
  @ApiOperation({ summary: 'KERI Out-Of-Band Introduction (OOBI) metadata for the Hub appliance' })
  @ApiResponse({ status: 200, description: 'OOBI discovery document for peer pairing' })
  async getHubOobi(@Req() req: Request) {
    const protocol = req.protocol || 'https';
    const host = req.get('host') || 'localhost';
    const url = `${protocol}://${host}`;

    // Appliance AID is bound to the directory
    const stable = await this.forwardAuthResolver.stableIdFor(1);
    const aid = stable?.hubAid ?? 'did:keri:EHubSovereignRoot_0000000000000000000000';

    return createOobiDiscoveryResponse({
      aid,
      role: 'hub',
      urls: [url],
      currentPublicKey: 'BActiveEd25519HubKey_000000000000000000000000',
      latestKelDigest: 'ELatestKelDigest_00000000000000000000000000000',
    });
  }

  @Get('.well-known/keri/oobi/:aid')
  @ApiOperation({ summary: 'Resolve OOBI for a specific AID' })
  @ApiResponse({ status: 200, description: 'OOBI record' })
  async getOobiForAid(@Param('aid') aid: string, @Req() req: Request) {
    const protocol = req.protocol || 'https';
    const host = req.get('host') || 'localhost';
    const url = `${protocol}://${host}`;

    return createOobiDiscoveryResponse({
      aid,
      role: 'peer',
      urls: [url],
      currentPublicKey: 'BActiveEd25519PeerKey_00000000000000000000000',
      latestKelDigest: 'ELatestKelDigest_00000000000000000000000000000',
    });
  }
}
