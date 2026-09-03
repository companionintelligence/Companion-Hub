/** HTTP context attached when an API response interceptor creates this error. */
export type TranslatableHttpContext = {
  status: number;
  url: string;
  /** Truncated response body (or message field) for Sentry; never used in UI. */
  body?: string;
};

export class TranslatableError extends Error {
  constructor(
    message: string,
    public intlParams?: Record<string, string>,
    public http?: TranslatableHttpContext,
  ) {
    super(message);
    this.name = 'TranslatableError';
  }
}
