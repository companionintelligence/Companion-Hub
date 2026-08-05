import { castAppUrn } from '@/common/helpers/app-helpers';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppStoreService } from '../app-stores/app-store.service';
import { AuthGuard } from '../auth/auth.guard';
import { RegistrationGuard } from '../registration/registration.guard';
import {
  AllAppStoresDto,
  AppMediaDto,
  AppStoreDto,
  CreateAppStoreBodyDto,
  PullDto,
  SearchAppsDto,
  SearchAppsQueryDto,
  UpdateAppStoreBodyDto,
  UpdateAppStoreDto,
} from './dto/marketplace.dto';
import { ImageSizeService } from './image-size.service';
import { MarketplaceService } from './marketplace.service';

@Controller('marketplace')
export class MarketplaceController {
  constructor(
    private readonly marketplaceService: MarketplaceService,
    private readonly appStoreService: AppStoreService,
    private readonly imageSizeService: ImageSizeService,
  ) {}

  @Get('apps/search')
  @UseGuards(AuthGuard, RegistrationGuard)
  @ApiResponse({ type: SearchAppsDto })
  async searchApps(@Query() query: SearchAppsQueryDto) {
    const { search, pageSize, cursor, category, storeId } = query;

    const size = pageSize ? Number(pageSize) : 24;
    if (Number.isNaN(size) || size <= 0) {
      throw new BadRequestException('Invalid pageSize');
    }
    const res = await this.marketplaceService.searchApps({ search, pageSize: size, cursor, category, storeId });

    return SearchAppsDto.parse(res, { reportOnly: true });
  }

  @Get('apps/:urn/image')
  async getImage(@Param('urn') urn: string, @Res() res: Response, @Req() req: Request) {
    const { image, etag, contentType } = await this.marketplaceService.getAppImage(castAppUrn(urn));

    if (!image) {
      throw new NotFoundException('App image not found');
    }

    if (req.headers['if-none-match'] === etag) {
      res.set({
        'Cache-Control': 'public, max-age=0, stale-while-revalidate=86400, stale-if-error=86400',
        'Content-Type': contentType || 'image/jpeg',
        ETag: etag,
      });
      return res.status(304).end();
    }

    res.set({
      'Cache-Control': 'public, max-age=0, stale-while-revalidate=86400, stale-if-error=86400',
      'Content-Type': contentType || 'image/jpeg',
      ETag: etag,
    });

    return res.send(image);
  }

  @Get('apps/:urn/image-size')
  @UseGuards(AuthGuard)
  async getAppImageSize(@Param('urn') urn: string) {
    return this.imageSizeService.getAppImageSize(castAppUrn(urn));
  }

  @Get('apps/:urn/media')
  @UseGuards(AuthGuard, RegistrationGuard)
  @ApiResponse({ type: AppMediaDto })
  async getAppMedia(@Param('urn') urn: string) {
    const media = await this.marketplaceService.getAppMedia(castAppUrn(urn));
    return AppMediaDto.parse(media, { reportOnly: true });
  }

  @Get('apps/:urn/screenshots/:filename')
  async getAppScreenshot(@Param('urn') urn: string, @Param('filename') filename: string, @Res() res: Response, @Req() req: Request) {
    const { image, etag, contentType } = await this.marketplaceService.getAppScreenshot(castAppUrn(urn), filename);

    if (!image) {
      throw new NotFoundException('Screenshot not found');
    }

    if (req.headers['if-none-match'] === etag) {
      res.set({
        'Cache-Control': 'public, max-age=0, stale-while-revalidate=86400, stale-if-error=86400',
        'Content-Type': contentType || 'image/jpeg',
        ETag: etag,
      });
      return res.status(304).end();
    }

    res.set({
      'Cache-Control': 'public, max-age=0, stale-while-revalidate=86400, stale-if-error=86400',
      'Content-Type': contentType || 'image/jpeg',
      ETag: etag,
    });

    return res.send(image);
  }

  @Get('apps/:urn/demo-video')
  async getAppDemoVideo(@Param('urn') urn: string, @Res() res: Response, @Req() req: Request) {
    const { video, etag, contentType } = await this.marketplaceService.getAppDemoVideo(castAppUrn(urn));

    if (!video) {
      throw new NotFoundException('Demo video not found');
    }

    if (req.headers['if-none-match'] === etag) {
      res.set({
        'Cache-Control': 'public, max-age=0, stale-while-revalidate=86400, stale-if-error=86400',
        'Content-Type': contentType || 'video/mp4',
        ETag: etag,
      });
      return res.status(304).end();
    }

    res.set({
      'Cache-Control': 'public, max-age=0, stale-while-revalidate=86400, stale-if-error=86400',
      'Content-Type': contentType || 'video/mp4',
      ETag: etag,
    });

    return res.send(video);
  }

  @Post('pull')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: PullDto })
  async pullAppStores() {
    const res = await this.appStoreService.pullRepositories();
    await this.marketplaceService.initialize();
    return PullDto.parse(res, { reportOnly: true });
  }

  @Post('create')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: AppStoreDto })
  async createAppStore(@Body() body: CreateAppStoreBodyDto) {
    const appStore = await this.appStoreService.createAppStore(body);
    await this.marketplaceService.initialize();

    return AppStoreDto.parse(appStore, { reportOnly: true });
  }

  @Get('all')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: AllAppStoresDto })
  async getAllAppStores() {
    const appStores = await this.appStoreService.getAllAppStores();

    return AllAppStoresDto.parse({ appStores }, { reportOnly: true });
  }

  @Get('enabled')
  @UseGuards(AuthGuard, RegistrationGuard)
  @ApiResponse({ type: AllAppStoresDto })
  async getEnabledAppStores() {
    const appStores = await this.appStoreService.getEnabledAppStores();

    return AllAppStoresDto.parse({ appStores }, { reportOnly: true });
  }

  @Patch(':id')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: UpdateAppStoreDto })
  async updateAppStore(@Param('id') id: string, @Body() body: UpdateAppStoreBodyDto) {
    await this.appStoreService.updateAppStore(id, body);
    await this.marketplaceService.initialize();

    return UpdateAppStoreDto.parse({ success: true }, { reportOnly: true });
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  async deleteAppStore(@Param('id') id: string) {
    await this.appStoreService.deleteAppStore(id);
    await this.marketplaceService.initialize();

    return { success: true };
  }
}
