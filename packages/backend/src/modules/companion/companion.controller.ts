import { Controller, Post, Get, Delete, Put, Body, Query, Req, Res, UseGuards, HttpCode } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { CompanionService } from './companion.service';
import type { ChatRequestDto, CompanionConfigDto } from './dto/companion.dto';

@UseGuards(AuthGuard)
@Controller('companion')
export class CompanionController {
  constructor(private readonly companionService: CompanionService) {}

  /**
   * Stream a chat response via SSE.
   * POST /api/companion/chat
   */
  @Post('chat')
  @HttpCode(200)
  async chat(@Body() body: ChatRequestDto, @Req() req: Record<string, unknown>, @Res() res: Response) {
    const userId = (req as { userId?: number }).userId || 1;
    const message = body.message;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const event of this.companionService.chat(userId, message)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: String(error) })}\n\n`);
    } finally {
      res.end();
    }
  }

  @Get('history')
  async getHistory(@Req() req: Record<string, unknown>, @Query('limit') limit?: string) {
    const userId = (req as { userId?: number }).userId || 1;
    const messages = await this.companionService.getHistory(userId, limit ? Number.parseInt(limit, 10) : undefined);
    return { messages };
  }

  @Delete('history')
  async clearHistory(@Req() req: Record<string, unknown>) {
    const userId = (req as { userId?: number }).userId || 1;
    await this.companionService.clearHistory(userId);
    return { success: true };
  }

  @Get('models')
  async getModels() {
    const models = await this.companionService.getModels();
    return { models };
  }

  @Get('tools')
  async getTools() {
    const tools = await this.companionService.getTools();
    return { tools };
  }

  @Put('config')
  async updateConfig(@Body() config: CompanionConfigDto) {
    await this.companionService.updateConfig(config);
    return { success: true };
  }

  @Get('status')
  async getStatus(@Req() req: Record<string, unknown>) {
    const userId = (req as { userId?: number }).userId || 1;
    return this.companionService.getStatus(userId);
  }
}
