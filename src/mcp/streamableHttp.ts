/**
 * Streamable HTTP transport wiring for the MCP server.
 *
 * Streamable HTTP is the MCP spec's successor to the deprecated HTTP+SSE
 * transport: one endpoint (here `/mcp`) serves both plain-JSON responses and SSE
 * streams, chosen per-request by the client's `Accept` header.
 *
 * This transport runs **stateless** — no `sessionIdGenerator` — so there is no
 * server-side session memory and no `sessionAffinity` requirement. The access key
 * is authenticated on every request by the caller (see src/mcp/auth.ts).
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export function createStreamableHttpTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no session persistence
    enableJsonResponse: true, // honor clients that prefer a one-shot JSON response
  });
}
