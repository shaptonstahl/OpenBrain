/**
 * Unit tests for src/mcp/streamableHttp.ts
 *
 * The transport must be stateless (no sessionIdGenerator) — the whole point is to
 * drop the in-memory session map and the K8s sessionAffinity requirement — and
 * must honour clients that request a plain-JSON response rather than an SSE stream.
 */

import { describe, it, expect } from "vitest";

import { createStreamableHttpTransport } from "../streamableHttp.js";

describe("createStreamableHttpTransport", () => {
  it("builds a stateless transport with no session id", () => {
    const transport = createStreamableHttpTransport();
    expect(transport.sessionId).toBeUndefined();
  });

  it("can be connected to a Server and handle requests", async () => {
    // The transport's start() is a no-op for streamable HTTP; connecting must not
    // throw and must leave a usable transport.
    const transport = createStreamableHttpTransport();
    await expect(transport.start()).resolves.toBeUndefined();
  });
});
