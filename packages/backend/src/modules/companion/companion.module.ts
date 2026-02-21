import { Module } from '@nestjs/common';
import { CompanionController } from './companion.controller';
import { CompanionService } from './companion.service';
import { OpenAICompatProvider } from './providers/openai-compat.provider';
import { ToolRegistry } from './tools/tool-registry';
import { AppTools } from './tools/app-tools';
import { SystemTools } from './tools/system-tools';
import { AlternativesTool } from './tools/alternatives-tool';
import { ConversationRepository } from './memory/conversation.repository';
import { ContextBuilder } from './memory/context-builder';
import { MarketplaceModule } from '@/modules/marketplace/marketplace.module';
import { AppsModule } from '@/modules/apps/apps.module';
import { SystemModule } from '@/modules/system/system.module';

@Module({
  imports: [MarketplaceModule, AppsModule, SystemModule],
  controllers: [CompanionController],
  providers: [CompanionService, OpenAICompatProvider, ToolRegistry, AppTools, SystemTools, AlternativesTool, ConversationRepository, ContextBuilder],
  exports: [CompanionService],
})
export class CompanionModule {}
