/**
 * Access-key extraction and authentication for the MCP endpoints.
 *
 * Shared by the legacy SSE transport (`/sse` + `/messages`) and the newer
 * Streamable HTTP transport (`/mcp`). Extracted out of index.ts so the key
 * resolution is unit-testable and the two endpoints cannot drift apart.
 *
 * The key is accepted from three places, in order of precedence:
 *   1. `x-brain-key` header      (existing convention, most explicit)
 *   2. `Authorization: Bearer`   (MCP Streamable HTTP convention)
 *   3. `?key=` query string      (header-less clients; requires opt-in)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";

import { authenticateAccessKey } from "../auth/accessKeys.js";
import { recordMcpHandshake, type KeySource } from "../api/metrics.js";
import { safeLogValue, clientAddress, describeRequestHeaders } from "./requestLog.js";

export interface McpKeyResolution {
  key: string | null;
  keySource: KeySource;
}

/**
 * Resolve the presented key from a request, honouring precedence and the
 * `MCP_ALLOW_KEY_IN_QUERY` opt-in. Returns `keySource: "query"` with a null key
 * when a key was supplied as `?key=` but query transport is disabled, so the
 * caller can still emit the "denied via query" diagnostic.
 */
export function extractMcpKey(
  headers: IncomingMessage["headers"],
  url: URL,
  allowKeyInQuery: boolean
): McpKeyResolution {
  const headerKey = headers["x-brain-key"];
  if (typeof headerKey === "string" && headerKey.length > 0) {
    return { key: headerKey, keySource: "header" };
  }

  const authorization = headers["authorization"];
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const bearer = authorization.slice("Bearer ".length).trim();
    if (bearer.length > 0) {
      return { key: bearer, keySource: "bearer" };
    }
  }

  const queryKey = url.searchParams.get("key");
  if (queryKey) {
    if (allowKeyInQuery) return { key: queryKey, keySource: "query" };
    return { key: null, keySource: "query" }; // supplied but disallowed
  }

  return { key: null, keySource: "none" };
}

export interface McpAuthSuccess {
  ok: true;
  keyId: string | null;
  label: string;
  keySource: KeySource;
  client: string;
  addr: string;
}

export interface McpAuthFailure {
  ok: false;
  reason: string;
  keySource: KeySource;
  client: string;
  addr: string;
}

export type McpAuthOutcome = McpAuthSuccess | McpAuthFailure;

/**
 * Authenticate one MCP request. Logs denials (and optionally header diagnostics)
 * with the same fields the SSE handler historically produced, and records the
 * handshake metric. Does not touch `res`; the caller decides how to respond.
 */
export async function authenticateMcpRequest(
  pool: pg.Pool,
  req: IncomingMessage,
  url: URL,
  options: {
    legacyKey: string;
    allowKeyInQuery: boolean;
    logHeaders: boolean;
    endpoint: string; // "/sse" or "/mcp", for log lines
  }
): Promise<McpAuthOutcome> {
  const { key, keySource } = extractMcpKey(req.headers, url, options.allowKeyInQuery);
  const client = safeLogValue(req.headers["user-agent"]);
  const addr = clientAddress(req.headers, req.socket.remoteAddress);

  if (options.logHeaders) {
    console.log(
      `[mcp] ${options.endpoint} headers ${describeRequestHeaders(
        req.headers,
        req.socket.remoteAddress
      )}`
    );
  }

  if (!options.allowKeyInQuery && keySource === "query") {
    console.warn(
      `[mcp] ${options.endpoint} denied: key supplied as ?key= but MCP_ALLOW_KEY_IN_QUERY is off`
    );
  }

  const auth = await authenticateAccessKey(pool, key, {
    legacyKey: options.legacyKey,
  }).catch((err: unknown) => {
    // A key lookup that cannot run is not permission to skip it.
    console.error(
      `[mcp] ${options.endpoint} denied: access key lookup failed —`,
      err instanceof Error ? err.message : String(err)
    );
    return { ok: false as const, reason: "unavailable" as const };
  });

  recordMcpHandshake(keySource, auth.ok ? "ok" : auth.reason);

  if (!auth.ok) {
    console.warn(
      `[mcp] ${options.endpoint} denied (${auth.reason}) via=${keySource} addr=${addr} client="${client}"`
    );
    return { ok: false, reason: auth.reason, keySource, client, addr };
  }

  return { ok: true, keyId: auth.keyId, label: auth.label, keySource, client, addr };
}

/** Write the standard JSON denial body for a failed MCP handshake. */
export function writeMcpAuthDenial(res: ServerResponse, reason: string): void {
  res.writeHead(reason === "unavailable" ? 503 : 401, {
    "Content-Type": "application/json",
  });
  res.end(
    JSON.stringify({
      error: reason === "unavailable" ? "Unavailable" : "Unauthorized",
    })
  );
}
