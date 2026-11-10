import { Module } from '@nestjs/common';
import { LoggerModule } from '@/core/logger/logger.module';
import { McpDisabledController } from './mcp-disabled.controller';

/** The stand-in for `McpModule` when MCP_ENABLED=false. AuthGuard needs only the logger. */
@Module({
  imports: [LoggerModule],
  controllers: [McpDisabledController],
})
export class McpDisabledModule {}
