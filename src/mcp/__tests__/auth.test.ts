/**
 * Unit tests for src/mcp/auth.ts
 *
 * The security-relevant cases are the precedence order (an attacker controlling
 * one field must not override a legitimate key supplied elsewhere) and the
 * `?key=` opt-in: a query key must never authenticate when the flag is off.
 */

import { describe, it, expect } from "vitest";
import type { IncomingHttpHeaders } from "node:http";
import type { ServerResponse } from "node:http";

import { extractMcpKey, writeMcpAuthDenial } from "../auth.js";

function headers(overrides: IncomingHttpHeaders = {}): IncomingHttpHeaders {
  return overrides;
}

describe("extractMcpKey — precedence", () => {
  it("prefers x-brain-key over Authorization and ?key=", () => {
    const r = extractMcpKey(
      headers({ "x-brain-key": "hk", authorization: "Bearer bk" }),
      new URL("http://x/mcp?key=qk"),
      true
    );
    expect(r).toEqual({ key: "hk", keySource: "header" });
  });

  it("falls back to Authorization: Bearer when no x-brain-key", () => {
    const r = extractMcpKey(
      headers({ authorization: "Bearer bk" }),
      new URL("http://x/mcp?key=qk"),
      true
    );
    expect(r).toEqual({ key: "bk", keySource: "bearer" });
  });

  it("falls back to ?key= when no header or bearer", () => {
    const r = extractMcpKey(headers(), new URL("http://x/mcp?key=qk"), true);
    expect(r).toEqual({ key: "qk", keySource: "query" });
  });

  it("reports none when no key is supplied anywhere", () => {
    const r = extractMcpKey(headers(), new URL("http://x/mcp"), true);
    expect(r).toEqual({ key: null, keySource: "none" });
  });
});

describe("extractMcpKey — Authorization parsing", () => {
  it("strips the Bearer prefix and trims whitespace", () => {
    const r = extractMcpKey(
      headers({ authorization: "Bearer   spaced-token  " }),
      new URL("http://x/mcp"),
      false
    );
    expect(r).toEqual({ key: "spaced-token", keySource: "bearer" });
  });

  it("ignores non-Bearer auth schemes", () => {
    const r = extractMcpKey(
      headers({ authorization: "Basic dXNlcjpwYXNz" }),
      new URL("http://x/mcp"),
      false
    );
    expect(r).toEqual({ key: null, keySource: "none" });
  });

  it("ignores an empty Bearer value", () => {
    const r = extractMcpKey(
      headers({ authorization: "Bearer " }),
      new URL("http://x/mcp"),
      false
    );
    expect(r).toEqual({ key: null, keySource: "none" });
  });

  it("ignores an empty x-brain-key value and falls through to bearer", () => {
    const r = extractMcpKey(
      headers({ "x-brain-key": "", authorization: "Bearer bk" }),
      new URL("http://x/mcp"),
      false
    );
    expect(r).toEqual({ key: "bk", keySource: "bearer" });
  });
});

describe("extractMcpKey — query opt-in", () => {
  it("uses ?key= when MCP_ALLOW_KEY_IN_QUERY is on", () => {
    const r = extractMcpKey(headers(), new URL("http://x/mcp?key=qk"), true);
    expect(r).toEqual({ key: "qk", keySource: "query" });
  });

  it("returns a null key but still reports 'query' when the flag is off", () => {
    const r = extractMcpKey(headers(), new URL("http://x/mcp?key=qk"), false);
    expect(r).toEqual({ key: null, keySource: "query" });
  });
});

describe("writeMcpAuthDenial", () => {
  function fakeRes() {
    const calls: { status: number; body: string }[] = [];
    const res = {
      writeHead(status: number) {
        calls.push({ status, body: "" });
      },
      end(body: string) {
        calls[calls.length - 1]!.body = body;
      },
    };
    return { res, calls };
  }

  it("writes 401 Unauthorized for an auth denial", () => {
    const { res, calls } = fakeRes();
    writeMcpAuthDenial(res as unknown as ServerResponse, "unknown");
    expect(calls[0]!.status).toBe(401);
    expect(JSON.parse(calls[0]!.body)).toEqual({ error: "Unauthorized" });
  });

  it("writes 503 Unavailable when the key lookup could not run", () => {
    const { res, calls } = fakeRes();
    writeMcpAuthDenial(res as unknown as ServerResponse, "unavailable");
    expect(calls[0]!.status).toBe(503);
    expect(JSON.parse(calls[0]!.body)).toEqual({ error: "Unavailable" });
  });
});
