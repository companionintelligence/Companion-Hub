import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { ChatMessage, LlmProvider, LlmProviderConfig, StreamEvent, ToolDefinition } from './llm-provider.interface';

/**
 * OpenAI-compatible LLM provider.
 * Works with Ollama, OpenAI, Anthropic (via proxy), Groq, Together, LM Studio, etc.
 */
@Injectable()
export class OpenAICompatProvider implements LlmProvider {
  private config: LlmProviderConfig;

  constructor(readonly _logger: LoggerService) {
    this.config = {
      baseUrl: process.env.COMPANION_LLM_URL || 'http://localhost:11434/v1',
      model: process.env.COMPANION_LLM_MODEL || 'llama3.2',
      apiKey: process.env.COMPANION_LLM_API_KEY || 'ollama',
    };
  }

  updateConfig(config: Partial<LlmProviderConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): LlmProviderConfig {
    return { ...this.config };
  }

  async *streamChat(messages: ChatMessage[], tools?: ToolDefinition[]): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map((m) => this.formatMessage(m)),
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey || ''}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      yield { type: 'error', content: `Failed to connect to LLM provider at ${this.config.baseUrl}: ${error}` };
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      yield { type: 'error', content: `LLM provider returned ${response.status}: ${text}` };
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: 'error', content: 'No response body from LLM provider' };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            // Emit any completed tool calls
            for (const tc of pendingToolCalls.values()) {
              yield {
                type: 'tool_call',
                toolCall: { id: tc.id, function: { name: tc.name, arguments: tc.args } },
              };
            }
            yield { type: 'done', finishReason: 'stop' };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            const finishReason = parsed.choices?.[0]?.finish_reason;

            if (delta?.content) {
              yield { type: 'token', content: delta.content };
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!pendingToolCalls.has(idx)) {
                  pendingToolCalls.set(idx, { id: tc.id || `call_${idx}`, name: '', args: '' });
                }
                const pending = pendingToolCalls.get(idx);
                if (!pending) continue;
                if (tc.id) pending.id = tc.id;
                if (tc.function?.name) pending.name += tc.function.name;
                if (tc.function?.arguments) pending.args += tc.function.arguments;
              }
            }

            if (finishReason === 'tool_calls') {
              for (const tc of pendingToolCalls.values()) {
                yield {
                  type: 'tool_call',
                  toolCall: { id: tc.id, function: { name: tc.name, arguments: tc.args } },
                };
              }
              yield { type: 'done', finishReason: 'tool_calls' };
              return;
            }

            if (finishReason && finishReason !== 'tool_calls') {
              yield { type: 'done', finishReason };
              return;
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done', finishReason: 'stop' };
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatMessage> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map((m) => this.formatMessage(m)),
      stream: false,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey || ''}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`LLM provider returned ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    };
    const choice = data.choices?.[0];

    return {
      role: 'assistant',
      content: choice?.message?.content || '',
      toolCalls: choice?.message?.tool_calls?.map((tc) => ({
        id: tc.id,
        function: tc.function,
      })),
    };
  }

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey || ''}`,
        },
      });

      if (!response.ok) return [];

      const data = (await response.json()) as { data?: Array<{ id: string }> };
      return (data.data || []).map((m) => ({ id: m.id, name: m.id }));
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }

  private formatMessage(msg: ChatMessage): Record<string, unknown> {
    const formatted: Record<string, unknown> = {
      role: msg.role,
      content: msg.content,
    };

    if (msg.toolCallId) {
      formatted.tool_call_id = msg.toolCallId;
    }

    if (msg.toolCalls) {
      formatted.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: tc.function,
      }));
    }

    return formatted;
  }
}
