import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { CustomDomainsService } from './custom-domains.service';
import { LaunchCustomDomainDto } from './custom-domains.dto';

/**
 * Hub proxy for the Entri custom-domain flow.
 *
 * All state lives in Portal; Hub adds local context and caches the domain list
 * briefly for UI responsiveness. See planning/epic-472-custom-domains-entri.md.
 */
@ApiTags('Custom Domains')
@UseGuards(AuthGuard)
@Controller('custom-domains')
export class CustomDomainsController {
  constructor(private readonly customDomainsService: CustomDomainsService) {}

  /**
   * Start the Entri Connect flow for a domain.
   * Returns the short-lived JWT and config the frontend passes to `entri.showEntri()`.
   */
  @Post('launch')
  @ApiOperation({ summary: 'Initiate Entri Connect for a custom domain' })
  @ApiResponse({ status: 200, description: 'Entri JWT + config ready for the modal' })
  @ApiResponse({ status: 502, description: 'Portal unreachable or returned an error' })
  async launch(@Body() dto: LaunchCustomDomainDto) {
    return this.customDomainsService.launch(dto);
  }

  /**
   * List all custom domains connected to this device / organization.
   * Served from a short-lived cache; refreshed on every Portal syncState cycle.
   */
  @Get()
  @ApiOperation({ summary: 'List custom domains for this Hub' })
  @ApiResponse({ status: 200, description: 'Array of CustomDomainStatus objects' })
  async list() {
    return this.customDomainsService.listDomains();
  }

  /**
   * Remove a custom domain — disconnects DNS monitoring and removes the
   * Cloudflare custom hostname from the Portal side.
   */
  @Delete(':id')
  @ApiOperation({ summary: 'Remove a custom domain' })
  @ApiResponse({ status: 200, description: 'Domain removed successfully' })
  async delete(@Param('id') id: string) {
    return this.customDomainsService.deleteDomain(id);
  }
}
