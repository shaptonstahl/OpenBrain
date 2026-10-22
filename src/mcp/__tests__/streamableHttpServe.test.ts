/**
 * Regression test for the stateless Streamable HTTP transport.
 *
 * The SDK's stateless transport is single-use: reusing one transport across
 * requests throws "Stateless transport cannot be reused across requests", and a
 * `Server` can only hold one transport at a time. The fix is a fresh Server +
 * transport per `/mcp` request. This spins up a real in-process HTTP server using
 * that pattern and asserts two consecutive requests both succeed (the second
 * would 500 if the transport were shared).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../db/connection.js", () => ({
  getPool: () => ({ query: vi.fn(), connect: vi.fn() }),
}));

vi.mock("../../embedder/index.js", () => ({
  getEmbedder: () => ({
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
    extractMetadata: vi.fn().mockResolvedValue({
      type: "observation",
      topics: [],
      people: [],
      action_items: [],
      dates: [],
    }),
  }),
}));

import { createMcpServer } from "../server.js";
import { createStreamableHttpTransport } from "../streamableHttp.js";

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  },
});

describe("stateless /mcp — fresh transport per request", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      if (req.url?.startsWith("/mcp")) {
        // The per-request pattern: fresh Server + transport each time.
        const mcp = createMcpServer();
        const transport = createStreamableHttpTransport();
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves consecutive requests without a 500", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: INITIALIZE,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { serverInfo?: { name?: string } };
      };
      expect(body.result?.serverInfo?.name).toBe("open-brain");
    }
  });
});
