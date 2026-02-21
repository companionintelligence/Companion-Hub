export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamEvent {
  type: 'token' | 'tool_call' | 'tool_result' | 'status' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  toolResult?: { callId: string; result: string };
  finishReason?: string;
}

export interface LlmProviderConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface LlmProvider {
  /**
   * Stream a chat completion, yielding events as they arrive.
   */
  streamChat(messages: ChatMessage[], tools?: ToolDefinition[]): AsyncGenerator<StreamEvent>;

  /**
   * Non-streaming chat completion.
   */
  chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatMessage>;

  /**
   * List available models from the provider.
   */
  listModels(): Promise<Array<{ id: string; name: string }>>;

  /**
   * Check if the provider is reachable.
   */
  healthCheck(): Promise<boolean>;
}
