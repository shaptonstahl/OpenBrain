/**
 * Open Brain — Entry Point
 *
 * Starts both:
 * 1. Hono REST API server (port 8000)
 * 2. MCP server via raw Node.js HTTP (port 8080)
 *
 * The REST API provides direct HTTP access for testing, Slack webhooks,
 * and any non-MCP integrations.
 *
 * The MCP server is the primary interface for AI tools (Claude, ChatGPT, etc).
 * It serves two transports over one raw Node.js HTTP server:
 *   - `/mcp`  — Streamable HTTP (stateless; the current MCP spec transport)
 *   - `/sse` + `/messages` — the legacy HTTP+SSE transport, kept for compatibility
 * Both use raw Node.js HTTP because the SDK transports need Node.js
 * ServerResponse objects (not the Web API).
 */

import http from "node:http";
import { serve } from "@hono/node-server";

import { initializeDatabase, closePool, getPool } from "./db/connection.js";
import { createApi } from "./api/routes.js";
import { createMcpServer } from "./mcp/server.js";
import { checkKeySources } from "./auth/accessKeys.js";
import { authenticateMcpRequest, writeMcpAuthDenial } from "./mcp/auth.js";
import { createStreamableHttpTransport } from "./mcp/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

/** An SSE session plus the identity of the key that opened it. */
interface McpSession {
  transport: SSEServerTransport;
  keyId: string | null;
  keyLabel: string;
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║           Open Brain v1.0.0              ║");
  console.log("║    Personal Semantic Memory System       ║");
  console.log("╚══════════════════════════════════════════╝");

  // Initialize database connection pool
  await initializeDatabase();

  const pool = getPool();
  const mcpAccessKey = process.env.MCP_ACCESS_KEY ?? "";
  // The key is accepted in the URL only when explicitly opted in: query strings land
  // in access logs, proxy logs and browser history. Clients that cannot set headers
  // (ChatGPT, Claude Desktop web connectors) need this on.
  const allowKeyInQuery =
    (process.env.MCP_ALLOW_KEY_IN_QUERY ?? "false").toLowerCase() === "true";
  // Diagnostic for issue #18 — see describeRequestHeaders().
  const logHeaders = (process.env.MCP_LOG_HEADERS ?? "false").toLowerCase() === "true";

  const keySources = await checkKeySources(pool, mcpAccessKey);
  if (!keySources.usable) {
    console.error("[auth] Refusing to start: no access keys configured.");
    console.error("[auth]   The MCP endpoint is reachable by anyone who can route to it,");
    console.error("[auth]   so serving with no key would make it an open memory store.");
    console.error("[auth]   Fix with either:");
    console.error("[auth]     • npm run key -- mint --label <name>   (named key, preferred)");
    console.error("[auth]     • MCP_ACCESS_KEY=<64-char hex>          (shared fallback)");
    await closePool();
    process.exit(1);
  }
  console.log(
    `[auth] ${keySources.namedKeys} named key(s); MCP_ACCESS_KEY fallback ${keySources.hasLegacyKey ? "enabled" : "not set"}.`
  );
  if (allowKeyInQuery) {
    console.warn("[auth] MCP_ALLOW_KEY_IN_QUERY=true — keys in ?key= are logged by proxies.");
  }

  // ── REST API Server (Hono) ──────────────────────────────────────

  const api = createApi();
  const apiPort = parseInt(process.env.API_PORT ?? "8000", 10);

  serve({ fetch: api.fetch, port: apiPort }, () => {
    console.log(`[api] REST API listening on http://0.0.0.0:${apiPort}`);
    console.log(`[api]   POST /memories         — capture thought`);
    console.log(`[api]   POST /memories/batch    — batch capture`);
    console.log(`[api]   POST /memories/search   — semantic search`);
    console.log(`[api]   POST /memories/list     — filtered listing`);
    console.log(`[api]   PUT  /memories/:id      — update thought`);
    console.log(`[api]   DELETE /memories/:id     — delete thought`);
    console.log(`[api]   GET  /stats             — brain statistics`);
    console.log(`[api]   GET  /health            — health check`);
  });

  // ── MCP Server (raw Node.js HTTP) ───────────────────────────────

  const mcpPort = parseInt(process.env.MCP_PORT ?? "8080", 10);

  // Track active SSE transports for cleanup
  const sessions = new Map<string, McpSession>();

  const mcpHttpServer = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, x-brain-key, Authorization, Mcp-Session-Id"
    );
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${mcpPort}`);

    // Health check — no auth required
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", service: "open-brain-mcp" }));
      return;
    }

    // SSE endpoint — AI clients connect here
    // Auth is checked here; /messages skips the key check because
    // having a valid sessionId proves the client already authenticated.
    if (url.pathname === "/sse" && req.method === "GET") {
      const auth = await authenticateMcpRequest(pool, req, url, {
        legacyKey: mcpAccessKey,
        allowKeyInQuery,
        logHeaders,
        endpoint: "/sse",
      });

      if (!auth.ok) {
        writeMcpAuthDenial(res, auth.reason);
        return;
      }

      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      sessions.set(sessionId, {
        transport,
        keyId: auth.keyId,
        keyLabel: auth.label,
      });

      res.on("close", () => {
        sessions.delete(sessionId);
        console.log(`[mcp] SSE session ${sessionId} closed`);
      });

      const server = createMcpServer();
      await server.connect(transport);
      console.log(
        `[mcp] SSE session ${sessionId} connected (key: ${auth.label}${auth.keyId ? ` / ${auth.keyId}` : ""}) via=${auth.keySource} addr=${auth.addr} client="${auth.client}"`
      );
      return;
    }

    // Messages endpoint — receives JSON-RPC calls from AI clients
    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      const session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "No active session. Connect to /sse first." })
        );
        return;
      }

      await session.transport.handlePostMessage(req, res);
      return;
    }

    // Streamable HTTP endpoint — serves JSON and SSE from one path. Stateless:
    // every request is authenticated independently, and the SDK transport is
    // single-use, so a fresh Server + transport are created per request.
    if (url.pathname === "/mcp") {
      const auth = await authenticateMcpRequest(pool, req, url, {
        legacyKey: mcpAccessKey,
        allowKeyInQuery,
        logHeaders,
        endpoint: "/mcp",
      });

      if (!auth.ok) {
        writeMcpAuthDenial(res, auth.reason);
        return;
      }

      const server = createMcpServer();
      const transport = createStreamableHttpTransport();
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    // 404 fallback
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  mcpHttpServer.listen(mcpPort, "0.0.0.0", () => {
    console.log(`[mcp] MCP server listening on http://0.0.0.0:${mcpPort}`);
    console.log(`[mcp]   POST /mcp               — Streamable HTTP (JSON or SSE)`);
    console.log(`[mcp]   GET  /sse               — SSE connection (legacy)`);
    console.log(`[mcp]   POST /messages           — JSON-RPC calls (legacy)`);
    console.log(`[mcp]   GET  /health             — health check`);
    console.log("");
    console.log("[mcp] Connect AI clients to:");
    console.log(`[mcp]   http://<host>:${mcpPort}/mcp   header: x-brain-key: <KEY>  or  Authorization: Bearer <KEY>`);
    console.log(`[mcp]   http://<host>:${mcpPort}/sse   header: x-brain-key: <KEY>  (legacy)`);
    if (allowKeyInQuery) {
      console.log(`[mcp]   http://<host>:${mcpPort}/mcp?key=<KEY>   (header-less clients)`);
    }
  });
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[shutdown] Received SIGINT, closing...");
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[shutdown] Received SIGTERM, closing...");
  await closePool();
  process.exit(0);
});

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
