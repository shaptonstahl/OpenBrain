# Migrating from SSE to Streamable HTTP

> How to move your MCP clients from the legacy HTTP+SSE transport (`/sse` + `/messages`)
> to Streamable HTTP (`/mcp`). Both transports run side-by-side, so this is a
> **rolling, zero-downtime** migration you can do one client at a time.

---

## TL;DR

1. Point each client at `/mcp` instead of `/sse`.
2. Move the access key out of the URL and into `Authorization: Bearer <KEY>` (or keep
   `x-brain-key`).
3. Repeat per client — nothing else changes. The seven tools are identical.
4. Once no client uses `/sse`, drop the K8s `sessionAffinity` requirement if you had it.

There is no data migration, no schema change, and no server flag to flip — `/mcp` is
already served on port `8080` alongside `/sse`.

---

## What changed

| Aspect | SSE (legacy) | Streamable HTTP (new) |
|---|---|---|
| Endpoint | `GET /sse` + `POST /messages` | one endpoint `POST /mcp` (plus `GET`/`DELETE` for session management) |
| Session model | server tracks a session; `/messages` trusts the session id | **stateless** — no session, no server-side state |
| Auth | key checked once on `/sse` | key checked on **every** request |
| Key location | `x-brain-key` header or `?key=` | `Authorization: Bearer` (new), `x-brain-key`, or `?key=` |
| Response | always an SSE stream | JSON **or** SSE, chosen by the client's `Accept` header |
| Multi-replica K8s | needs `sessionAffinity: ClientIP` | no session affinity needed |

**Key precedence** on `/mcp`: `x-brain-key` → `Authorization: Bearer` → `?key=`
(the last only when `MCP_ALLOW_KEY_IN_QUERY=true`).

---

## Why migrate

- The HTTP+SSE transport is **deprecated** by the MCP specification; Streamable HTTP is
  its replacement.
- **One endpoint** replaces two, and removes the `/sse`-then-`/messages` handshake.
- **No session affinity.** The classic "SSE works once, then *session not found*" failure
  in multi-replica deployments disappears.
- **Bearer auth** keeps the key out of URLs, proxy logs and browser history.

---

## The plan

Do this **client by client**. Because `/sse` stays available, a half-migrated setup works
exactly as well as a fully-migrated one — there is no cut-over moment and no outage window.

1. Confirm `/mcp` is live (see [Verify below](#verify)).
2. Pick one client, edit its config, restart, and confirm the tools still load.
3. Repeat until every client is on `/mcp`.
4. Optional cleanup: remove the K8s `sessionAffinity` patch (see
   [Deployment cleanup](#deployment-cleanup)).

If anything misbehaves, point that client back at `/sse` and move on — rollback is just a
config revert.

---

## Per-client migration

Replace the URL and move the key to a header. Exact snippets live in
[04-MCP-SERVER.md](04-MCP-SERVER.md) and [README — Client Configuration](../README.md#client-configuration);
the changes below are the essential delta.

| Client | Change |
|---|---|
| **Claude Code** | `"type": "sse"` → `"type": "http"`; `url` `/sse?key=…` → `/mcp`; add `"headers": { "Authorization": "Bearer …" }` |
| **Cursor** | `"transport": "sse"` → `"transport": "http"`; `url` `/sse?key=…` → `/mcp`; add `"headers": { "Authorization": "Bearer …" }` |
| **VS Code / Copilot** | `"type": "sse"` → `"type": "http"`; `url` `/sse?key=…` → `/mcp`; add `"headers": { "Authorization": "Bearer …" }` |
| **Windsurf** | `serverUrl` `/sse?key=…` → `/mcp`; supply the key via a supported header (or `x-brain-key`) |
| **ChatGPT / Gemini** | these cannot send custom headers — use `/mcp?key=<KEY>` (requires `MCP_ALLOW_KEY_IN_QUERY=true`) and keep auth "None" |
| **Claude Desktop** | continues via `mcp-remote` for now; a Streamable-HTTP-native config works where the client supports `"type": "http"` |

Two concrete examples:

```jsonc
// Claude Code — before (SSE)
{ "mcpServers": { "openbrain": {
    "type": "sse",
    "url": "http://<host>:8080/sse?key=<KEY>"
} } }

// Claude Code — after (Streamable HTTP)
{ "mcpServers": { "openbrain": {
    "type": "http",
    "url": "http://<host>:8080/mcp",
    "headers": { "Authorization": "Bearer <KEY>" }
} } }
```

```jsonc
// Cursor — before (SSE)
{ "mcpServers": { "openbrain": {
    "url": "http://<host>:8080/sse?key=<KEY>",
    "transport": "sse"
} } }

// Cursor — after (Streamable HTTP)
{ "mcpServers": { "openbrain": {
    "url": "http://<host>:8080/mcp",
    "transport": "http",
    "headers": { "Authorization": "Bearer <KEY>" }
} } }
```

---

## Auth changes

You are not forced to change how the key is transmitted — `/mcp` accepts all three forms.
But because the key is now checked on **every request** (not once per connection), the
same key works unchanged; you only need to decide *where* to put it:

- **Recommended:** `Authorization: Bearer <KEY>` — the MCP Streamable HTTP convention,
  and a header (not logged in URLs/proxy logs).
- **Already using `x-brain-key`:** keep it; it still works and takes precedence over Bearer.
- **Header-less clients** (ChatGPT, Gemini): continue with `?key=`, now on `/mcp?key=…`.
  Still gated by `MCP_ALLOW_KEY_IN_QUERY=true`.

> If you set both `x-brain-key` and `Authorization` on the same request, `x-brain-key`
> wins. Don't rely on that — set one.

---

## Deployment cleanup

Only after **every** client is off `/sse`:

- **Kubernetes** ([09-SELF-HOSTED-K8S.md](09-SELF-HOSTED-K8S.md)): the
  `sessionAffinity: ClientIP` patch existed solely for the stateful SSE transport. Remove
  it once no `/sse` client remains. Leave it in place while *any* client still uses `/sse`.
- **Azure Container Apps** ([10-AZURE-DEPLOYMENT.md](10-AZURE-DEPLOYMENT.md)): the
  `affinity: sticky` ingress setting serves the same purpose — safe to drop after the same
  point.

Nothing else in any deployment needs to change: `/mcp` is on the same port `8080`, behind
the same Funnel / ingress / firewall rule as `/sse`.

---

## Verify

```bash
# Health (no auth)
curl -s http://localhost:8080/health

# /mcp tools/list — JSON response (Accept: application/json)
curl -s http://localhost:8080/mcp \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# /mcp tools/list — SSE response (Accept: text/event-stream)
curl -sN http://localhost:8080/mcp \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A successful call returns the seven tools (`capture_thought`, `capture_thoughts`,
`delete_thought`, `list_thoughts`, `search_thoughts`, `thought_stats`, `update_thought`).
An auth failure returns `401 Unauthorized` (or `503` if the key lookup itself failed).

You can also point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
at `/mcp` to confirm a real client handshake.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401` on `/mcp` | Key missing or wrong. Confirm it matches a row in `access_keys` (or `MCP_ACCESS_KEY`), and that you sent `Authorization: Bearer …` or `x-brain-key`. |
| `?key=` ignored | `MCP_ALLOW_KEY_IN_QUERY` is off. Turn it on, or move the key to a header. |
| Claude connector: "server asked for sign-in (status 404)" | The connector cached a stale auth verdict after a `401`. **Remove the connector and re-add it**, pointing at the URL **with the key in it** (`/sse?key=…` or `/mcp?key=…`) and auth = "none". See [TROUBLESHOOTING.md](TROUBLESHOOTING.md). |
| Client connects but no tools | It may still be pointed at `/sse`; confirm the URL ends in `/mcp` and the transport is `"http"`. |
| `/sse` still works, `/mcp` 404 | You are on an old build — `/mcp` shipped after the Streamable HTTP support was added. Rebuild/redeploy. |

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the full set of fixes.

---

## Rollback

`/sse` + `/messages` remain enabled. Reverting a client is a single config change back to
the SSE URL and `"type": "sse"` / `"transport": "sse"`. No server-side change is needed in
either direction.
