import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStateStore } from "../../src/gateway/state.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("gateway state", () => {
  it("persists turns, reply targets, and permissions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-"));
    dirs.push(dir);
    const state = createStateStore(dir);
    const now = Date.now();
    state.setReplyTarget("ck", { channel: "imessage", conversationId: "conv" });
    state.saveTurn({
      id: "msg_1",
      messageID: "msg_1",
      chatKey: "ck",
      state: "queued",
      kind: "normal",
      text: "hello",
      deliver: true,
      createdAt: now,
      updatedAt: now,
    });
    state.savePermission({
      permissionID: "perm-1",
      sessionID: "sess-1",
      chatKey: "ck",
      title: "Read files",
      deadline: now + 1_000,
      state: "pending",
    });

    const restored = createStateStore(dir);
    expect(restored.getReplyTarget("ck")?.conversationId).toBe("conv");
    expect(restored.getTurn("msg_1")?.text).toBe("hello");
    expect(restored.listPermissions()[0]?.permissionID).toBe("perm-1");
  });

  it("writes private state files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-"));
    dirs.push(dir);
    const state = createStateStore(dir);
    state.update({ tunnelId: "tunnel-1" });

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(state.filePath).mode & 0o777).toBe(0o600);
  });

  it("leases a turn to one gateway owner", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-"));
    dirs.push(dir);
    const state = createStateStore(dir);
    const now = Date.now();
    state.saveTurn({
      id: "msg_1",
      messageID: "msg_1",
      chatKey: "ck",
      state: "submitted",
      kind: "normal",
      text: "hello",
      deliver: false,
      createdAt: now,
      updatedAt: now,
    });

    expect(state.claimTurn("msg_1", "owner-a", 10_000)?.ownerId).toBe("owner-a");
    expect(createStateStore(dir).claimTurn("msg_1", "owner-b", 10_000)).toBeUndefined();
    state.updateTurn("msg_1", { leaseUntil: Date.now() - 1 });
    expect(createStateStore(dir).claimTurn("msg_1", "owner-b", 10_000)?.ownerId).toBe("owner-b");
  });

  it("leases only one active turn per chat", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-"));
    dirs.push(dir);
    const state = createStateStore(dir);
    const now = Date.now();
    for (const id of ["msg_1", "msg_2"]) {
      state.saveTurn({
        id,
        messageID: id,
        chatKey: "ck",
        state: "queued",
        kind: "normal",
        text: id,
        deliver: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    expect(state.claimTurn("msg_1", "owner-a", 10_000)).toBeDefined();
    expect(state.claimTurn("msg_2", "owner-b", 10_000)).toBeUndefined();
    state.updateTurn("msg_1", { state: "completed" });
    expect(state.claimTurn("msg_2", "owner-b", 10_000)).toBeDefined();
  });

  it("does not overwrite a turn after its expected state changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-state-"));
    dirs.push(dir);
    const state = createStateStore(dir);
    const now = Date.now();
    state.saveTurn({
      id: "msg_1",
      messageID: "msg_1",
      chatKey: "ck",
      state: "queued",
      kind: "normal",
      text: "hello",
      deliver: false,
      createdAt: now,
      updatedAt: now,
    });

    expect(state.transitionTurn("msg_1", ["queued"], { state: "interrupted" })?.state).toBe(
      "interrupted",
    );
    expect(state.transitionTurn("msg_1", ["queued"], { state: "submitting" })).toBeUndefined();
    expect(state.getTurn("msg_1")?.state).toBe("interrupted");
  });
});
