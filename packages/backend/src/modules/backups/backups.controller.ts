import { castAppUrn } from '@/common/helpers/app-helpers';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { BackupsService } from './backups.service';
import { BackupRequestDto, DeleteAppBackupBodyDto, GetAppBackupsDto, GetAppBackupsQueryDto, RestoreAppBackupDto } from './dto/backups.dto';

@Injectable()
@UseGuards(AuthGuard)
@Controller('backups')
export class BackupsController {
  constructor(
    private readonly backupsService: BackupsService,
    private readonly whois: MarketplaceWhoIsService,
  ) {}

  @Post(':urn/backup')
  @ApiResponse({ type: BackupRequestDto })
  async backupApp(@Param('urn') urn: string, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'backup');
    const res = await this.backupsService.backupApp({ appUrn });
    return BackupRequestDto.parse(res, { reportOnly: true });
  }

  @Post(':urn/restore')
  @ApiResponse({ type: BackupRequestDto })
  async restoreAppBackup(@Param('urn') urn: string, @Body() body: RestoreAppBackupDto, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'restore');
    const res = await this.backupsService.restoreApp({ appUrn, filename: body.filename });
    return BackupRequestDto.parse(res, { reportOnly: true });
  }

  @Get(':urn')
  @ApiResponse({ type: GetAppBackupsDto })
  async getAppBackups(@Param('urn') urn: string, @Query() query: GetAppBackupsQueryDto, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'view');
    const backups = await this.backupsService.getAppBackups({ appUrn, page: query.page ?? 0, pageSize: query.pageSize ?? 10 });

    return GetAppBackupsDto.parse(backups, { reportOnly: true });
  }

  @Delete(':urn')
  async deleteAppBackup(@Param('urn') urn: string, @Body() body: DeleteAppBackupBodyDto, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'backup');
    return this.backupsService.deleteAppBackup({ appUrn, filename: body.filename });
  }

  @Get(':urn/:filename/download')
  @ApiResponse({ status: 200, description: 'Backup file download' })
  async downloadBackup(@Param('urn') urn: string, @Param('filename') filename: string, @Res() res: Response, @Req() req: Request) {
    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'view');
    const filePath = await this.backupsService.getBackupFilePath({ appUrn, filename });

    res.set({
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });

    return res.sendFile(filePath);
  }

  @Post(':urn/upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Backup uploaded successfully' })
  async uploadBackup(
    @Param('urn') urn: string,
    @Req() req: Request,
    @UploadedFile() file?: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    if (!file) {
      throw new BadRequestException('No backup file provided');
    }

    if (!file.originalname.endsWith('.tar.gz') && file.mimetype !== 'application/gzip' && file.mimetype !== 'application/x-gzip') {
      throw new BadRequestException('File must be a .tar.gz backup file');
    }

    const appUrn = castAppUrn(urn);
    await this.whois.assertSessionAction(req, appUrn, 'backup');

    await this.backupsService.uploadBackup({
      appUrn,
      filename: file.originalname,
      fileBuffer: file.buffer,
    });

    return { success: true };
  }
}
