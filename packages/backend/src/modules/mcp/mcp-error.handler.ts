import { HttpStatus } from '@nestjs/common';

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function formatToolSuccess(result: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
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
      message = error.message;
    }
  } else {
    message = 'An unexpected error occurred.';
  }

  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
