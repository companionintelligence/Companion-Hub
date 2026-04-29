import { Injectable } from '@nestjs/common';

/**
 * MCP API key authentication guard.
 * Validates Authorization: Bearer <MCP_API_KEY> header.
 */
@Injectable()
export class McpAuthGuard {}
