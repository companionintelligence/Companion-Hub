import { Body, Controller, Get, Param, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AuthGuard } from '../auth/auth.guard';
import { CustomAppService } from './custom-apps.service';
import { PortExposeService } from './port-expose.service';
import {
  CreateCustomAppDto,
  CreateCustomAppResponseDto,
  CustomAppAccessDto,
  CreatePortExposeAppDto,
  UpdateAppMetadataDto,
  UpdateCustomAppDto,
  UpdatePortExposeAppDto,
} from './dto/custom-apps.dto';
import { ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { castAppUrn } from '@/common/helpers/app-helpers';

@Controller('custom-apps')
export class CustomAppController {
  constructor(
    private readonly customAppService: CustomAppService,
    private readonly portExposeService: PortExposeService,
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  @Post('port-expose')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: CreateCustomAppResponseDto })
  async createPortExposeApp(@Body() body: CreatePortExposeAppDto) {
    const result = await this.portExposeService.createPortExposeApp(body);
    return CreateCustomAppResponseDto.parse(
      {
        appUrn: result.appUrn,
        appName: result.appName,
        storeId: result.storeId,
      },
      { reportOnly: true },
    );
  }

  /**
   * What the UI should offer the signed-in person on a custom app: every Hub verb for an organization
   * owner or admin, the member fallback for an operator with no linked Portal identity, and only `view`
   * for anyone else. It reads the role the Hub stored at sign-in rather than asking the Portal, so the
   * page shows its controls at once (`customAppActionsHint`). The routes still ask the Portal fresh and
   * decide.
   */
  @Get('access')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: CustomAppAccessDto })
  async getCustomAppAccess(@Req() req: Request) {
    return CustomAppAccessDto.parse({ actions: await this.whois.customAppActionsHint(req) }, { reportOnly: true });
  }

  @Post()
  @UseGuards(AuthGuard)
  @ApiResponse({ type: CreateCustomAppResponseDto })
  async createCustomApp(@Body() body: CreateCustomAppDto, @Req() req: Request) {
    // Only an organization owner or admin may create a custom app; a role that can't be read refuses it.
    await this.whois.assertSessionMayCreateCustomApp(req);
    const result = await this.customAppService.createCustomApp(body);
    return CreateCustomAppResponseDto.parse(
      {
        appUrn: result.appUrn,
        appName: result.appName,
        storeId: result.storeId,
      },
      { reportOnly: true },
    );
  }

  @Patch('port-expose/:urn')
  @UseGuards(AuthGuard)
  @ApiResponse({})
  async updatePortExposeApp(@Param('urn') appUrn: string, @Body() body: UpdatePortExposeAppDto) {
    await this.portExposeService.updatePortExposeApp(castAppUrn(appUrn), body);
    return { success: true };
  }

  @Patch(':urn')
  @UseGuards(AuthGuard)
  @ApiResponse({})
  async updateCustomApp(@Param('urn') urn: string, @Body() body: UpdateCustomAppDto, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    // Changing a custom app takes an organization owner or admin; `MarketplaceWhoIsService` decides that for `configure` on a `_user` app.
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    return await this.customAppService.updateCustomApp(appUrn, body.config);
  }

  @Post(':urn/image')
  @UseGuards(AuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Logo uploaded successfully' })
  async uploadAppImage(@Param('urn') urn: string, @Req() req: Request, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'configure');

    if (!file) {
      throw new BadRequestException('No image file provided');
    }

    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException('File must be an image');
    }

    if (file.mimetype !== 'image/jpeg' && file.mimetype !== 'image/jpg') {
      throw new BadRequestException('Only JPG files are allowed');
    }

    await this.customAppService.uploadAppImage(appUrn, file.buffer);
    return { success: true };
  }

  @Patch(':urn/metadata')
  @UseGuards(AuthGuard)
  @ApiResponse({})
  async updateAppMetadata(@Param('urn') urn: string, @Body() body: UpdateAppMetadataDto, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'configure');
    return await this.customAppService.updateAppMetadata(appUrn, body.data);
  }
}
