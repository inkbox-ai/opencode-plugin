# Changelog

## 0.2.16 (unreleased)

- Adds opt-in Slack setup, six identity-owned tools, signed inbound routing, and channel-wide Companion context with exact source-thread replies.
- Uses inline eyes only for top-level replies and native working/awaiting-input status in Slack subthreads, including approval and shutdown cleanup.
- Ignores unengaged Slack channel chatter, preserves bounded sender-profile context, honors canonical home-workspace allowlists, and marks failed inline replies with an X.
- Verifies native iMessage source/backend support before send checkpoints or uploads; doctor reports read-only channel capability and webhook readiness without claiming delivery.
- Adds opt-in native iMessage replies, durable source admission, bounded first-source bursts, serialized follow-ups, bounded thread reads, and observed-send deduplication.
- Preserves explicitly requested sends to other iMessage recipients or conversations without borrowing the current reply target or suppressing its answer; stale source turns remain fenced.
- Preserves unknown submission/send outcomes without replay. Native execution must be positively fenced before later work can proceed; diagnostics separate liveness from queue readiness.
- Keeps crossed send outcomes inspectable after Stop and retains unsent saved answers across shutdown or feature changes during final reply preparation.
- Releases definite pre-submission failures for later valid work, retains proactive iMessage failures as quiet context, and keeps reactions and compatible message bursts in their native conversation queue.
- Serializes remote approval prompts, preserves control and fresh-message routing, and binds shared-route responses to the prompted author.
- Allocates native prompt IDs at durable submission, after prior native messages, while keeping receipt IDs and uncertain submissions stable across restart.
- Handles current and legacy native permission events and retires owned, unsubmitted approval prompts during shutdown without conflicting with in-flight responses.
- Runs packed native messaging, permission-lifecycle, and cross-process source-owner contracts against both the minimum supported OpenCode 1.15.0 and the latest host.
- Keeps Vault tools optional: metadata remains locked-safe, individual credentials and grants are refreshed, login TOTP seeds are redacted, and the generic credential read requires exact-name enablement.
- Requires published `@inkbox/sdk` 0.7.14. Migrate the default Vault key environment variable to `INKBOX_OPENCODE_VAULT_KEY`; a custom `vault.keyEnvVar` remains supported.

## 0.2.15 (unreleased)

- Adds Companion mode for sponsored email, MMS, and iMessage groups with isolated conversation sessions and one complete initialization input.
- Persists pending history loading and live messages before acknowledging delivery. Uncertain host submissions and sends pause the conversation instead of being replayed.
- Keeps group reply audiences and local sponsor admission checks. Historical commands and group replies cannot answer remote tool approvals.
- Requires published `@inkbox/sdk` 0.7.7. Companion mode remains opt-in through identity settings.

- Adds Safe/Relaxed Companion response modes, optional explicit mentions, current To addressing for email, and wizard settings.
- Keeps quiet context across restarts without a model turn; live-first history never invokes a historical sponsor separately.
- Isolates ordinary group/reaction sessions, binds approvals and replies to the originating sender/route, and uses canonical email reply-all.
- Recovers transient host startup and send-preparation failures without losing sessions or regenerating completed replies.
- Clears buffered context on session reset, reconciles accepted context after restart, and resolves incomplete email approvals without waiting behind the paused host turn.
- Restores ordinary reply-length recovery, bounds permanent preparation retries, and preserves same-contact direct-message approval answers across channels while binding shared-group approvals to their sender.

## Unreleased

- Updates Vitest and pins its Vite runtime to patched releases.
- Stabilizes hosted voice checks by waiting for a quiet greeting and verifying the caller request on both call legs.
- Updates transitive HTTP and development dependencies to patched versions.
- Runs live test files sequentially to avoid interference between channel checks.
- Adds negotiated 16 kHz PCM call audio with streaming resampling and legacy call compatibility.
- Uses the published, pinned SDK in CI and gives periodic progress delivery time to finish before the live task ends.
- Retries connection failures during live identity discovery without repeating task submissions.

## 0.2.9 (unreleased)

- Adds a resumable, non-interactive `inkbox-opencode bootstrap` command for existing identities, hosted Voice AI, explicit signing-key rotation, and background gateway startup.
- Adds explicit Inkbox Voice AI, OpenAI Realtime API, and Inkbox TTS/STT phone-call stacks to setup.
- Routes hosted calls through Voice AI and reconciles `call.ended` commitments in the OpenCode session.
- Guards hosted post-call SMS with an exact-target durable journal and a bounded correction policy.
- Uses `@inkbox/sdk` 0.5.9 and disables voicemail detection throughout live call CI.

## 0.2.7 (unreleased)

- Adds safely framed matched-contact memories to inbound email, SMS, iMessage,
  reaction, and voice context. Disable them with `gateway.contactMemories` or
  `INKBOX_CONTACT_MEMORIES_ENABLED=false`.

## 0.1.1 (unreleased)

- iMessage groups now match the rest of the plugin fleet: a group is one shared
  context, so the conversation keys the chat rather than the sender and every
  participant lands in the same session. The frame carries the participant list
  and `reply_mode=conversation_id` alongside the existing reply-only-when-
  addressed policy. `to` accepts 1-8 recipients; opening a group requires a
  dedicated outbound iMessage line.
- Setup now restarts a background gateway that is already running instead of
  reporting success and leaving it on the previous `.env`. The boot-autostart
  path already forced a service restart for this reason; the background path
  now matches it.
- Setup closes on a status banner naming the Inkbox identity and the health
  command when a gateway ends up live, instead of a sign-off that reads the
  same whether or not anything is running.
- Setup confirms the gateway is actually up before saying so. `startDaemon`
  returns as soon as it has spawned, so a gateway that failed to bind still
  reported success; the wizard now polls for liveness and points at the log
  instead of printing the banner over a process that is gone.
- Adds identity-bound A2A 1.0 client tools plus durable inbound task serving:
  context-scoped sessions, restart catch-up, task-addressed cancellation, and
  explicit complete/ask/fail intents. Outbound calls and replies use the
  existing approval and recipient-allowlist controls.
- Adds paginated task and message history with direction, participant,
  lifecycle, context, role, keyword, and timestamp filters.
- The plugin uses exactly `@inkbox/sdk` 0.5.9.

## 0.1.0 (unreleased)

Initial release.

- Requires `@inkbox/sdk` 0.5.6 or newer.
- 56 `inkbox_*` tools across A2A, email, SMS/MMS, iMessage, calls, contacts,
  notes, contact rules, note access grants, encrypted vault, and diagnostics. 35 are
  enabled by default; the rest are opt-in via the `tools.enable` plugin option
  (`inkbox_doctor` reports what is off and how to enable it).
- Outbound sends and calls gate through opencode's native permission prompts,
  with a recipient allowlist and configurable approval modes for unattended
  runs.
- Credentials resolve from plugin options, `INKBOX_*` environment variables,
  or `~/.inkbox/config`.
- 12 bundled skills covering email triage, SMS/iMessage response etiquette,
  outbound calling, contact management, notes, credential use, and
  troubleshooting.
- Optional inbound gateway (off by default): receives email, SMS, iMessage,
  and calls to the agent's identity and turns each into an opencode session
  that replies on the same channel. Contact-keyed sessions, signature
  verification and dedup, per-contact permission relaying, control commands,
  inbound/outbound media, delivery-failure recovery, and external webhook
  providers. Voice answers calls via Inkbox speech or an OpenAI Realtime
  raw-audio bridge with in-call actions. Runs as a sidecar
  (`inkbox-opencode`) or inside `opencode serve`.
- Local-file media on `inkbox_send_email` (`attachmentPaths`),
  `inkbox_send_sms`/`inkbox_send_imessage` (`mediaPaths`); `inkbox_place_call`
  carries a call purpose and opening message.
- Realtime voice follow-ups recover from completed calls even when the media
  socket stays open, using the persisted call transcript to execute promised
  post-call work.
