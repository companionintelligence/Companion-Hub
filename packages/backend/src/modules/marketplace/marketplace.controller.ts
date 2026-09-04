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
import { pipeline } from 'node:stream/promises';
import { LoggerService } from '@/core/logger/logger.service';
import { AppStoreService } from '../app-stores/app-store.service';
import { AuthGuard } from '../auth/auth.guard';
import { RegistrationGuard } from '../registration/registration.guard';
import { parseByteRange } from './app-media.helpers';
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
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { MarketplaceService } from './marketplace.service';

const isExpectedStreamAbortError = (error: unknown) => {
  if (!(error instanceof Error) || !('code' in error)) {
    return false;
  }

  return error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ECONNRESET' || error.code === 'EPIPE';
};

@Controller('marketplace')
export class MarketplaceController {
  constructor(
    private readonly marketplaceService: MarketplaceService,
    private readonly appStoreService: AppStoreService,
    private readonly imageSizeService: ImageSizeService,
    private readonly logger: LoggerService,
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  @Get('apps/search')
  @UseGuards(AuthGuard, RegistrationGuard)
  @ApiResponse({ type: SearchAppsDto })
  async searchApps(@Query() query: SearchAppsQueryDto, @Req() req: Request) {
    const { search, pageSize, cursor, category, storeId } = query;

    const size = pageSize ? Number(pageSize) : 24;
    if (Number.isNaN(size) || size <= 0) {
      throw new BadRequestException('Invalid pageSize');
    }
    const res = await this.marketplaceService.searchApps({ search, pageSize: size, cursor, category, storeId });
    const data = await this.whois.filterSessionByView(req, res.data, (app) => app.urn, 'store');

    return SearchAppsDto.parse({ ...res, data }, { reportOnly: true });
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
    const file = await this.marketplaceService.getAppDemoVideo(castAppUrn(urn));

    if (!file) {
      throw new NotFoundException('Demo video not found');
    }

    const { size, etag, contentType } = file;
    const headers: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=0, stale-while-revalidate=86400, stale-if-error=86400',
      'Content-Type': contentType || 'video/mp4',
    };
    if (etag) {
      headers.ETag = etag;
    }

    if (etag && req.headers['if-none-match'] === etag) {
      res.set(headers);
      return res.status(304).end();
    }

    const range = parseByteRange(req.headers.range, size);

    if (range === 'unsatisfiable') {
      res.set({ ...headers, 'Content-Range': `bytes */${size}` });
      return res.status(416).end();
    }

    if (size === 0) {
      res.set({ ...headers, 'Content-Length': '0' });
      return res.status(200).end();
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;

    res.set({
      ...headers,
      'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    res.status(range ? 206 : 200);

    const stream = this.marketplaceService.createDemoVideoStream(file, start, end);

    try {
      await pipeline(stream, res);
    } catch (error) {
      // Seeking and tab-closing abort in-flight video requests constantly; that is not an error.
      if (!isExpectedStreamAbortError(error)) {
        this.logger.warn(`Demo video stream failed for ${urn}: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) {
          res.status(500);
        }
      }
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  @Post('pull')
  @UseGuards(AuthGuard)
  @ApiResponse({ type: PullDto })
  async pullAppStores() {
    const res = await this.appStoreService.pullRepositories();
    await this.marketplaceService.initialize();
    await this.marketplaceService.refreshPortalCatalog();
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
