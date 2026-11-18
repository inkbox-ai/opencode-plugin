# Remote tools

`inkbox_remote_tools` discovers complete tool descriptors and JSON schemas in bounded pages.
`inkbox_remote_call` invokes a discovered tool and preserves its structured result and metadata.
The native schema adapters cannot represent every remote JSON Schema constraint, so discovery and
execution use a generic relay. The SDK validates arguments against the full captured schema before
submission. A running user turn retains its catalog; the next turn discovers additions, changes and
removals without a plugin update.

Calls retain the native session, parent message and tool-call identity. Repeating arguments in a new
call does not reuse an earlier operation. Cancellation, a replaced incoming owner or revoked authority
prevents further execution. Interactive approval follows the configured native Ask policy; verified
incoming messages use their separate gateway policy. Recipient allowlists remain enforced. Remote
writes whose destinations cannot be checked against an allowlist require the existing local tool.

Claimed identities use the remote catalog by default. Admin-scoped and unclaimed credentials keep
their local setup behavior. Unknown or unavailable authority never silently falls back to a local
implementation of a migrated tool.

| Capability | Implementation |
| --- | --- |
| Contact lookup, list, get, create, update and delete | Existing names delegate to canonical remote tools for claimed identities, preserving labelled addresses, primary flags and patch semantics. |
| Email and SMS | Existing local tools retain threading, media, allowlists and delivery recovery; canonical remote tools are discoverable. |
| iMessage, WhatsApp and Slack | Existing channel-specific history, conversation, reaction, media and source-bound delivery behavior remains local. |
| Calls, live audio and A2A | Existing native callbacks and lifecycle remain local. |
| Vault, local cryptography, note grants and schedules | Existing local capabilities remain; discovery does not widen their authority. |
| Final incoming email or direct SMS reply | `inkbox_reply_current` derives the destination from the admitted source and records durable acceptance. |

The final-reply helper supplies explicit final intent. Progress and unrelated sends do not suppress
the automatic final answer. Group SMS and other channels retain existing delivery behavior. A pending
send must reconcile with its original operation; editing its text cannot create a second send. A
rejection before submission leaves the source available for a corrected reply.

Remote journals contain hashes, continuations and accepted message IDs, not message bodies. They are
scoped by connection and native session or delivery route. Session and journal capacities are bounded.
Retire a journal only after its session and uncertain operations have settled. Reconnect the plugin
after exhausting its in-memory catalog capacity; never delete live journals to recover capacity.

The separate `./runtime` entry exposes the existing gateway and native host adapters for embedders.
`dispatchVerified` requires an already verified Inkbox event; it does not authenticate raw requests.
`eventState` distinguishes admission from completed work, including delayed bursts, native turns and
post-call jobs. Interrupted routing remains uncertain. Embedders must preserve the gateway state and
wait for completion before releasing an admitted event.

OpenCode V1 requires 1.17.18 or newer because earlier versions do not provide a usable asynchronous
plugin approval API. V2 supports 2.0.26 through 2.0.x. Source builds use pnpm 10 and the immutable SDK
revision in `pnpm-lock.yaml`; SDK 0.7.38 must be available before registry-only dependency installation.
Packed native tests use synthetic model and MCP services and do not establish live account availability.
