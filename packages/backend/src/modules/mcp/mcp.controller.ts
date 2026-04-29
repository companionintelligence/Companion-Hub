import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpAuthGuard } from './mcp-auth.guard';
import { type JsonRpcRequest, McpService } from './mcp.service';

@Controller('mcp')
export class McpController {
  private sseClients = new Set<Response>();

  constructor(private readonly mcpService: McpService) {}

  @Get('sse')
  @UseGuards(McpAuthGuard)
  sse(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const endpointUrl = `${req.protocol}://${req.get('host')}/api/mcp/messages`;
    res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

    this.sseClients.add(res);

    const cleanup = () => this.sseClients.delete(res);
    req.on('close', cleanup);
    res.on('error', cleanup);
    res.on('finish', cleanup);
  }

  @Post('messages')
  @UseGuards(McpAuthGuard)
  async messages(@Body() body: JsonRpcRequest) {
    return this.mcpService.handleMessage(body);
  }

  get activeConnections(): number {
    return this.sseClients.size;
  }
}
