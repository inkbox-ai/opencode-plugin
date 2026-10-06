// Fresh-process resolver proof using a real native assistant parent and the
// live gateway's submitted receipt. No Inkbox API or model task is performed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const [directory, port, stateDirectory, turnID, assistantID] = process.argv.slice(2);
const packed = join(directory, "node_modules/@inkbox/opencode-plugin/dist");
const load = (name) => import(pathToFileURL(join(packed, name)).href);
const [{ nativeSource, assertNativeOwner }, { createStateStore }] = await Promise.all([
  load("imessage-native.js"),
  load("gateway/state.js"),
]);
const state = createStateStore(stateDirectory);
const original = state.getTurn(turnID);
assert.equal(original?.state, "submitted");
assert.ok(original.ownerId && original.leaseUntil > Date.now());
const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
const context = { messageID: assistantID, directory };
const owned = await nativeSource(original.sessionID, context, client, state);
assert.deepEqual(owned, {
  ...original.replyTarget,
  nativeOwner: { turnId: original.id, ownerId: original.ownerId },
});
assertNativeOwner(owned, state);
// The user prompt itself is not an assistant tool context.
await assert.rejects(
  nativeSource(original.sessionID, { ...context, messageID: original.messageID }, client, state),
  /source is unavailable/,
);
const copyDirectory = mkdtempSync(join(directory, "source-contract-"));
try {
  const legacy = {
    id: original.messageID,
    messageID: original.messageID,
    chatKey: original.chatKey,
    sessionID: original.sessionID,
    state: "submitted",
    kind: "normal",
    text: "Retained legacy receipt",
    deliver: true,
    replyTarget: original.replyTarget,
    ownerId: "legacy-owner",
    leaseUntil: Date.now() + 30000,
    createdAt: 1,
    updatedAt: 1,
  };
  const copied = createStateStore(copyDirectory);
  copied.update({
    sessions: { [legacy.chatKey]: legacy.sessionID },
    turns: {
      [legacy.id]: legacy,
      "voice-owner": {
        ...legacy,
        id: "voice-owner",
        messageID: "voice-native-prompt",
        chatKey: "other-voice-chat",
        sessionID: "other-voice-session",
        replyTarget: undefined,
        ownerId: "voice-owner",
        hostedCapture: {
          identityId: "synthetic-identity",
          callId: "synthetic-call",
          phase: "initial",
          expectedTarget: "+15555550101",
        },
      },
    },
  });
  const recovered = await nativeSource(legacy.sessionID, context, client, copied);
  assert.deepEqual(recovered.imessageSource, original.replyTarget.imessageSource);
  assert.deepEqual(recovered.nativeOwner, { turnId: legacy.id, ownerId: "legacy-owner" });
  copied.updateTurn(legacy.id, { leaseUntil: 0 });
  await assert.rejects(nativeSource(legacy.sessionID, context, client, copied), /no longer owns/);
  assert.throws(() => assertNativeOwner(recovered, copied), /no longer owns/);
  copied.updateTurn(legacy.id, { leaseUntil: Date.now() + 30000, state: "interrupted" });
  await assert.rejects(nativeSource(legacy.sessionID, context, client, copied), /no longer owns/);
  assert.throws(() => assertNativeOwner(recovered, copied), /no longer owns/);
  assert.equal(copied.getTurn("voice-owner").state, "submitted");
  assert.deepEqual(state.getTurn(turnID).replyTarget, original.replyTarget);
  console.log(
    "PASS: packed cross-process native source ownership, legacy receipts, and stale-owner rejection contract",
  );
} finally {
  rmSync(copyDirectory, { recursive: true, force: true });
}
