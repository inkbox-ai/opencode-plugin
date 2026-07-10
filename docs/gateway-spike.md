# Gateway-mode spike: can the inbound gateway live inside an opencode plugin?

Inbound gateway mode (people email/text the agent and it responds) needs a
long-lived process that (1) holds an Inkbox tunnel open, (2) turns inbound
webhooks into opencode sessions, and (3) tears the tunnel down cleanly. This
spike tests whether those three things can run inside a plugin under
`opencode serve`, before any gateway code is written.

Environment: opencode 1.15.11 (plugins execute under Bun 1.3.14), Node 22,
`@inkbox/sdk` 0.4.19.

## Findings

### 1. Bun can speak the tunnel's protocol — PASS (local probe)

The tunnel data plane (`@inkbox/sdk/tunnels/connect`) is documented Node-only
and relies on `node:http2` with RFC 8441 extended CONNECT. Probed Bun 1.3.14
directly against a local Node h2c echo server:

| Probe | Node 22 (control) | Bun 1.3.14 |
|---|---|---|
| `remoteSettings.enableConnectProtocol` surfaced | yes | yes |
| Plain HTTP/2 GET | ok | ok |
| `CONNECT` + `:protocol: websocket` stream (RFC 8441) | 200 + echo | 200 + echo |
| `import "@inkbox/sdk/tunnels/connect"` | ok | ok |
| `import "@inkbox/sdk"` (client CRUD) | ok | ok |

Caveat: this is a loopback probe of the protocol primitive, not a live tunnel
session against the tunnel edge (that needs provisioned agent credentials and
should be the first test in a future live-tunnel integration pass). But the failure mode this spike was
designed to catch — Bun lacking client-side extended CONNECT — did not appear.

### 2. Plugins run (lazily) inside `opencode serve` — PASS with caveats

- Plugin code executes in the server process under Bun (verified by marker
  writes from inside the plugin during `opencode serve`).
- **Loading is lazy**: `opencode serve` alone does not load plugins; the first
  API request that touches the project does. A headless gateway deployment
  must poke the server once after start (any session-scoped request works).
- **The plugin function can run more than once** (one load per instance
  scope). Gateway startup must be idempotent — a singleton guard around
  tunnel open, or the second open supersedes the first
  (`TunnelSupersededError` exists in the SDK for exactly this pattern).

### 3. Driving sessions from inside a plugin — PASS with a hard rule

`input.client.session.create(...)` from the plugin works and returns a real
session (`ses_…`), **but only when deferred past plugin init**. Awaiting a
server-API call inside the plugin function itself deadlocks instance
creation: the request needs the instance, the instance is waiting on the
plugin function. Rule for gateway code: the plugin function only wires state;
tunnel open and any `client.*` calls start on a deferred tick (or an event
hook), never inline.

Prompting a session end-to-end (`session.prompt` + reading the reply) needs a
configured model provider and real Inkbox webhook traffic — deferred to a
future integration pass on a machine with provider credentials.

### 4. `dispose` on shutdown — FAIL

SIGINT to `opencode serve` did not run the plugin's `dispose` hook (tested
repeatedly; the marker never appears). Consequence: tunnel teardown must not
depend on `dispose`. Mitigations, in combination:

- process signal handlers (`SIGINT`/`SIGTERM`) registered by the gateway,
- server-side supersede-on-reconnect semantics (a restarted gateway takes
  over the tunnel name; the stale session is evicted),
- keep `dispose` wired anyway — it may fire on graceful instance disposal
  and future opencode versions may extend when it runs.

## Verdict

Gateway-in-plugin is viable: the two potential architecture-killers (Bun
tunnel protocol support; driving sessions from a plugin) both pass. The
constraints that survive into the design are operational, not architectural:
deferred startup, idempotent tunnel open, signal-based teardown, and a
post-start poke for lazy loading. A Node sidecar remains the documented
fallback if the live-tunnel integration test surfaces Bun issues the local
probe could not.
