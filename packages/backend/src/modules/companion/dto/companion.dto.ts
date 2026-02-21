export interface ChatRequestDto {
  message: string;
}

export interface ChatResponseDto {
  role: 'assistant';
  content: string;
}

export interface CompanionConfigDto {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface CompanionStatusDto {
  configured: boolean;
  connected: boolean;
  model: string;
  provider: string;
  toolCount: number;
  messageCount: number;
}
