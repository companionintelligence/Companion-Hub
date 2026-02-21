import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { OpenAICompatProvider } from './providers/openai-compat.provider';
import { ToolRegistry } from './tools/tool-registry';
import { ConversationRepository } from './memory/conversation.repository';
import { ContextBuilder } from './memory/context-builder';
import type { ChatMessage, StreamEvent } from './providers/llm-provider.interface';
import type { CompanionConfigDto, CompanionStatusDto } from './dto/companion.dto';

const MAX_TOOL_ROUNDS = 5;

@Injectable()
export class CompanionService {
  constructor(
    private readonly logger: LoggerService,
    private readonly llmProvider: OpenAICompatProvider,
    private readonly toolRegistry: ToolRegistry,
    private readonly conversationRepo: ConversationRepository,
    private readonly contextBuilder: ContextBuilder,
  ) {}

  /**
   * Stream a chat response, handling tool calls automatically.
   */
  async *chat(userId: number, userMessage: string): AsyncGenerator<StreamEvent> {
    // Save user message
    await this.conversationRepo.saveMessage(userId, { role: 'user', content: userMessage });

    // Build messages array with system prompt + history
    const systemPrompt = await this.contextBuilder.buildSystemPrompt();
    const history = await this.conversationRepo.getHistory(userId, 30);
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history];

    const toolDefs = this.toolRegistry.getDefinitions();
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      let fullContent = '';
      const toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = [];
      let _finishReason = 'stop';

      for await (const event of this.llmProvider.streamChat(messages, toolDefs)) {
        if (event.type === 'token') {
          fullContent += event.content || '';
          yield event;
        } else if (event.type === 'tool_call' && event.toolCall) {
          toolCalls.push(event.toolCall);
          yield { type: 'status', content: `Calling ${event.toolCall.function.name}...` };
        } else if (event.type === 'error') {
          yield event;
          return;
        } else if (event.type === 'done') {
          _finishReason = event.finishReason || 'stop';
        }
      }

      if (toolCalls.length === 0) {
        // No tool calls — save assistant response and finish
        if (fullContent) {
          await this.conversationRepo.saveMessage(userId, { role: 'assistant', content: fullContent });
        }
        yield { type: 'done', finishReason: 'stop' };
        return;
      }

      // Process tool calls
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: fullContent || '',
        toolCalls,
      };
      messages.push(assistantMsg);
      await this.conversationRepo.saveMessage(userId, assistantMsg);

      for (const tc of toolCalls) {
        this.logger.info(`Companion tool call: ${tc.function.name}(${tc.function.arguments})`);
        const result = await this.toolRegistry.execute(tc.function.name, tc.function.arguments);

        const toolMsg: ChatMessage = {
          role: 'tool',
          content: result,
          toolCallId: tc.id,
        };
        messages.push(toolMsg);
        await this.conversationRepo.saveMessage(userId, toolMsg);

        yield { type: 'tool_result', toolResult: { callId: tc.id, result } };
      }

      // Continue the loop to let the LLM respond to tool results
    }

    yield { type: 'error', content: 'Too many tool call rounds' };
  }

  async getHistory(userId: number, limit?: number) {
    return this.conversationRepo.getHistory(userId, limit);
  }

  async clearHistory(userId: number) {
    return this.conversationRepo.clearHistory(userId);
  }

  async getModels() {
    return this.llmProvider.listModels();
  }

  async getTools() {
    return this.toolRegistry.listTools();
  }

  async updateConfig(config: CompanionConfigDto) {
    this.llmProvider.updateConfig(config);
  }

  async getStatus(userId: number): Promise<CompanionStatusDto> {
    const connected = await this.llmProvider.healthCheck();
    const config = this.llmProvider.getConfig();
    const messageCount = await this.conversationRepo.getMessageCount(userId);
    const tools = this.toolRegistry.listTools();

    return {
      configured: !!config.baseUrl,
      connected,
      model: config.model,
      provider: config.baseUrl,
      toolCount: tools.length,
      messageCount,
    };
  }
}
