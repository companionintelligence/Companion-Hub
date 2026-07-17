import { HttpStatus } from '@nestjs/common';

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function formatToolSuccess(result: unknown): McpToolResult {
  // `JSON.stringify(undefined)` returns `undefined` (and so do function/symbol values). The MCP SDK
  // validates every tools/call result against CallToolResultSchema, which requires `text` to be a
  // string — a non-string here turns a SUCCESSFUL tool (e.g. a void-returning delete/update) into a
  // JSON-RPC error the agent may retry. Coerce a void/undefined result to a stable "null".
  const text = JSON.stringify(result);
  return {
    content: [{ type: 'text', text: text ?? 'null' }],
  };
}

/** Pull `intlParams` off an HttpException-style response body, if present. */
function extractIntlParams(error: unknown): Record<string, string | undefined> | undefined {
  const getResponse = (error as { getResponse?: () => unknown }).getResponse;
  if (typeof getResponse !== 'function') {
    return undefined;
  }

  const body = getResponse.call(error);
  if (body && typeof body === 'object' && 'intlParams' in body) {
    const intlParams = (body as { intlParams?: unknown }).intlParams;
    if (intlParams && typeof intlParams === 'object') {
      return intlParams as Record<string, string | undefined>;
    }
  }

  return undefined;
}

export function formatToolError(error: unknown, appUrn?: string): McpToolResult {
  let message: string;

  if (error instanceof Error) {
    const statusCode = (error as unknown as Record<string, number>).status ?? (error as unknown as Record<string, number>).statusCode;

    if (statusCode === HttpStatus.NOT_FOUND) {
      message = appUrn ? `App ${appUrn} not found. Use hub_search_apps to find available apps.` : `Resource not found. ${error.message}`;
    } else if (statusCode === HttpStatus.UNAUTHORIZED || statusCode === HttpStatus.FORBIDDEN) {
      message = 'Authentication failed. Check the Hub API key configuration.';
    } else {
      // TranslatableError carries the human-readable detail (e.g. the still-connected
      // consumer apps) in `intlParams`; `error.message` is only the translation key,
      // so append the params or the agent gets an opaque key string.
      const intlParams = extractIntlParams(error);
      message = intlParams ? `${error.message} ${JSON.stringify(intlParams)}` : error.message;
    }
  } else {
    message = 'An unexpected error occurred.';
  }

  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
