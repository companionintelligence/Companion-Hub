import { LATEST_PROTOCOL_VERSION, type Implementation } from '@modelcontextprotocol/sdk/types.js';

/** First MCP revision using the stateless per-request envelope (no initialize session). */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** Protocol revisions the Hub MCP endpoint advertises and serves. */
export const HUB_MCP_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION] as const;

/** Server identity advertised in the MCP `initialize` handshake and on the admin status. */
export const HUB_MCP_SERVER_INFO: Readonly<Implementation> = Object.freeze({ name: 'ci-hub', version: '1.0.0' });
