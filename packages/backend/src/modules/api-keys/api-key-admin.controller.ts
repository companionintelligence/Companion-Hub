import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ApiKeyAdminService } from './api-key-admin.service';
import { CreateApiKeyBody } from './api-key-admin.dto';

/**
 * Operator-facing hub-wide API-key surface, powering the Settings → Security "API keys" card.
 * Session-authed ({@link AuthGuard}) so the browser never handles agent keys; raw key values are
 * returned exactly once at creation and never listed. The MCP settings screen links here — key
 * management is hub-wide, not an MCP-subsystem concern.
 */
@Controller('api-keys')
@UseGuards(AuthGuard)
export class ApiKeyAdminController {
  constructor(private readonly adminService: ApiKeyAdminService) {}

  /** List all stored API keys (operator + app-managed, every scope). Never returns raw keys. */
  @Get()
  async listKeys() {
    return { keys: await this.adminService.listKeys() };
  }

  /** Create an operator API key. Returns the raw key ONCE so it can be copied; only the hash is stored. */
  @Post()
  createKey(@Body() body: CreateApiKeyBody) {
    return this.adminService.createKey(body.name);
  }

  /** Revoke a key by id (create-new → roll-out → revoke-old is the no-downtime rotation flow). */
  @Delete(':id')
  revokeKey(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.revokeKey(id);
  }
}
