import { ContentBlockSchema, type CallToolResult, type ContentBlock } from '@modelcontextprotocol/sdk/types.js';

/**
 * Marks a handler's return value as an MCP `tools/call` result that goes out as it is. Every other
 * tool's return is JSON-encoded into one text item (`formatToolSuccess`), which is right for the
 * Hub's own records and wrong for an app MCP server's result: that already has content items (text,
 * a file as a resource, an image) and its own `isError`. Encoding it again gave the agent JSON inside
 * JSON inside JSON. A call the app refused looked like a success.
 *
 * The mark is a non-enumerable symbol, so the admin tool runner, which hands the handler's value to the
 * Hub UI as JSON, still sees a plain `{ content, isError }` object.
 */
const CALL_TOOL_RESULT = Symbol('mcp.callToolResult');

export function markCallToolResult(result: CallToolResult): CallToolResult {
  Object.defineProperty(result, CALL_TOOL_RESULT, { value: true, enumerable: false });
  return result;
}

export function isMarkedCallToolResult(value: unknown): value is CallToolResult {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[CALL_TOOL_RESULT] === true;
}

/** The wire result for a marked handler value: its content and `isError`, nothing else it carried. */
export function toWireCallToolResult(result: CallToolResult): CallToolResult {
  return result.isError ? { content: result.content, isError: true } : { content: result.content };
}

/**
 * Read what the MCP bridge returned for one app tool call as a `tools/call` result, or `null` when it
 * is neither shape the bridge produces (the caller then falls back to the encoded form).
 *
 * - An upstream result, `{ content: [...], isError? }`: each content item the protocol defines is kept
 *   as it is; anything else becomes a text item holding its JSON, so one odd item can't fail the call.
 *   The Hub's tool declares no output schema, so `structuredContent` doesn't go out as a field. A
 *   server should repeat it in a text item and most do. When the result has no content at all (a
 *   2026-07-28 server may send `structuredContent` alone, which the client reads as `content: []`),
 *   its JSON becomes the one text item so the agent still gets the data.
 * - A bridge refusal, `{ error: '...', isError: true }` (app not running, not installed, a timeout, the
 *   server's JSON-RPC error): one text item with the message plus `isError`.
 */
export function bridgedCallToolResult(raw: unknown): CallToolResult | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;

  if (Array.isArray(record.content)) {
    const content: ContentBlock[] = record.content.map((item) => {
      const parsed = ContentBlockSchema.safeParse(item);
      return parsed.success ? parsed.data : { type: 'text', text: JSON.stringify(item) ?? 'null' };
    });
    if (content.length === 0 && record.structuredContent !== undefined) {
      content.push({ type: 'text', text: JSON.stringify(record.structuredContent) ?? 'null' });
    }
    return record.isError === true ? { content, isError: true } : { content };
  }

  if (typeof record.error === 'string') {
    return { content: [{ type: 'text', text: record.error }], isError: true };
  }

  return null;
}
