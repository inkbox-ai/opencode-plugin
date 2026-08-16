# Live CI

These Actions exercise the installed plugin against live Inkbox identities. Each component Action supports reusable and manual execution; credential-gated tests skip outside configured live jobs. Tests use current-run markers or pre-request snapshots so stale records cannot pass.

## Full stack e2e

Runs the reusable Actions in sequence for ready same-repository pull requests, manual dispatches, and successful canary runs on `main`. The orchestrated voice call includes the conditional inbound scenario.

### `full-stack`

**Proves:** Every live suite passes as one required gate. **Flow:** 1. Run channels. 2. Run Agent2Agent. 3. Run voice. 4. Run external events. 5. Fail unless every suite succeeded.

## Live — Agent2Agent

Runs all five scenarios serially with both live identity credentials.

### `inbound-single`

**Proves:** The plugin completes one inbound A2A task. **Flow:** 1. Send a tagged task. 2. Wait for completion. 3. Require the tag in task history.

### `inbound-multi`

**Proves:** An inbound task can request and consume follow-up input. **Flow:** 1. Send a tagged task. 2. Wait for `input-required`. 3. Reply in the same task. 4. Require both tags at completion.

### `inbound-progress`

**Proves:** A long-running inbound task acknowledges pickup, publishes ordered nonterminal progress on schedule, and completes with the expected result. **Flow:** 1. Send a two-minute calculation task. 2. Require acknowledgement within 30 seconds. 3. Require two progress messages about one minute apart. 4. Require the tagged final calculation from the worker.

### `outbound-single`

**Proves:** The agent delegates work without completing its outer task early. **Flow:** 1. Request delegation. 2. Find the tagged worker task. 3. Complete it remotely. 4. Require its result in the outer completion.

### `outbound-multi`

**Proves:** Delegation preserves a worker's input round trip. **Flow:** 1. Start a delegated task. 2. Receive its input request. 3. Reply through the agent. 4. Complete the worker. 5. Require its result in the outer task.

## Live — agent channels (email + SMS)

The `mock` matrix leg runs only the deterministic tests; the `real` leg runs only the real-model tests. Both require live identity credentials.

### `email — mock model: the nonce travels inbound → model → reply → delivery`

**Proves:** The complete email transport works deterministically. **Flow:** 1. Snapshot inbound email IDs. 2. Send a unique nonce. 3. Wait for a fresh reply. 4. Require the nonce and mock marker.

### `email — real model: replies with actual content`

**Proves:** The real agent can answer over email. **Flow:** 1. Snapshot inbound email IDs. 2. Request a fixed acknowledgement. 3. Wait for a fresh reply. 4. Reject error text and require the acknowledgement.

### `SMS — mock model: the nonce travels inbound → model → reply → delivery`

**Proves:** The complete SMS transport works deterministically. **Flow:** 1. Send a unique nonce. 2. Wait for a fresh inbound reply. 3. Require the nonce and mock marker.

### `SMS — real model: reports its own identity when asked`

**Proves:** The real agent receives context and answers over SMS. **Flow:** 1. Read the agent mailbox. 2. Ask for that address by SMS. 3. Wait for a fresh reply. 4. Require the exact address.

## Live — voice calls (Voice AI + Realtime + Inkbox TTS/STT)

Requires both live identity credentials and a real model. Outbound Realtime and Voice AI always run; inbound TTS/STT runs only when `include_inbound` is true.

### `inbound: driver calls, agent answers via Inkbox TTS/STT and replies`

**Proves:** Inbound client-media calling uses Inkbox speech services. **Flow:** 1. Snapshot agent calls. 2. Place a call with voicemail detection disabled. 3. Require two-way speech. 4. Verify the persisted call policy and speech mode. 5. Hang up.

### `outbound: 'call me' text → agent calls back on the Realtime path and replies`

**Proves:** A message-triggered callback uses Realtime. **Flow:** 1. Snapshot both owners' calls. 2. Text the request. 3. Require exactly one fresh paired call after duplicate grace. 4. Require two-way speech, Realtime flags, and disabled voicemail detection. 5. Hang up.

### `outbound: Voice AI call settles one exact-target post-call SMS`

**Proves:** Hosted calling completes one durable post-call action. **Flow:** 1. Snapshot both call owners and sender-side SMS rows. 2. Request a hosted call. 3. Require one fresh pair, reason, saved authority, and disabled voicemail detection. 4. Before hangup, require caller intent and a matching open action. 5. Hang up. 6. Require completed reconciliation and exactly one current-marker SMS to the caller after duplicate grace.

## Live — external events (webhook → agent acts)

Runs only with live identity credentials, a real model, the webhook signing secret, and the gateway log used to correlate the exact turn.

### `rejects forged GitHub hooks and completes a valid real-model turn`

**Proves:** External events are authenticated before agent execution. **Flow:** 1. Send an invalidly signed event and require rejection with no turn. 2. Send a valid event. 3. Require acceptance. 4. Wait for the exact request's completed agent turn.
