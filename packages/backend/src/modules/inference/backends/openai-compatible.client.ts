import axios, { type AxiosRequestConfig } from 'axios';

export interface OpenAiModelResource {
  id: string;
  owned_by?: string;
}

/**
 * Small shared client for OpenAI-compatible model servers.
 *
 * Backends own their lifecycle semantics, but model discovery and request
 * plumbing should not be reimplemented for every server that speaks the
 * common `/v1/models` contract.
 */
export class OpenAiCompatibleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly headers?: Record<string, string>,
  ) {}

  async listModels(timeout = 10_000): Promise<OpenAiModelResource[]> {
    const config: AxiosRequestConfig = { timeout };
    if (this.headers) {
      config.headers = this.headers;
    }
    const response = await axios.get(`${this.baseUrl}/v1/models`, config);
    const models = response.data?.data;
    return Array.isArray(models) ? models.filter((model): model is OpenAiModelResource => typeof model?.id === 'string') : [];
  }
}
