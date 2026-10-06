import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGatewayConfig, type ResolvedConfig } from "../../src/config.js";
import { createSessionManager } from "../../src/gateway/sessions.js";
import { createStateStore, type DurableTurn } from "../../src/gateway/state.js";

const fault = vi.hoisted(() => ({
  file: "",
  stage: "",
  after: false,
  fired: false,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync(from: fs.PathLike, to: fs.PathLike) {
      if (String(to) === fault.file) {
        const next = JSON.parse(actual.readFileSync(from, "utf8"));
        const turn = next.turns?.receipt;
        const native = Object.values(next.imessageSends ?? {}) as {
          state: string;
        }[];
        const matches =
          fault.stage === "native-started"
            ? native.some((entry) => entry.state === "started")
            : fault.stage === "native-sent"
              ? native.some((entry) => entry.state === "sent")
              : turn?.state === fault.stage;
        if (fault.fired || matches) {
          if (!fault.fired && fault.after) actual.renameSync(from, to);
          fault.fired = true;
          // Keep storage unavailable through error cleanup. Recovery must read
          // the last published checkpoint, not a later compensating write.
          throw new Error("Synthetic primary checkpoint publication failure");
        }
      }
      return actual.renameSync(from, to);
    },
  };
});

const dirs: string[] = [];
const managers: ReturnType<typeof createSessionManager>[] = [];
afterEach(async () => {
  fault.file = "";
  for (const manager of managers.splice(0)) await manager.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-checkpoint-"));
  dirs.push(dir);
  const identity = {
    id: "synthetic-identity",
    getIMessage: vi.fn(async () => ({
      id: "source",
      conversationId: "conversation",
    })),
    getIMessageThread: vi.fn(async () => ({
      conversationId: "conversation",
      messages: [],
    })),
    sendIMessage: vi.fn(async () => ({
      id: "accepted-output",
      conversationId: "conversation",
    })),
  };
  const opencode = {
    session: {
      messages: vi.fn(async () => ({
        data: [
          { info: { id: "native-prompt", role: "user" }, parts: [] },
          {
            info: {
              id: "native-answer",
              parentID: "native-prompt",
              role: "assistant",
              finish: "stop",
            },
            parts: [{ type: "text", text: "Saved native answer" }],
          },
        ],
      })),
      status: vi.fn(async () => ({ data: {} })),
      promptAsync: vi.fn(),
      create: vi.fn(),
      abort: vi.fn(async () => ({ data: true })),
    },
  };
  const config = {
    gateway: { ...defaultGatewayConfig(), imessageThreadedReplies: true },
  } as ResolvedConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const start = () => {
    const state = createStateStore(dir);
    const manager = createSessionManager({
      state,
      config,
      opencode: opencode as never,
      inkbox: { getIdentity: async () => identity } as never,
      logger,
      directory: "/synthetic-project",
    });
    managers.push(manager);
    return { state, manager };
  };
  return { dir, identity, opencode, config, logger, start };
}

function receipt(): DurableTurn {
  return {
    id: "receipt",
    messageID: "native-prompt",
    chatKey: "conversation",
    sessionID: "native-session",
    state: "submitted",
    kind: "normal",
    text: "Original request",
    deliver: true,
    replyTarget: {
      channel: "imessage",
      conversationId: "conversation",
      imessageSource: { messageId: "source", conversationId: "conversation" },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("primary native checkpoints across restart", () => {
  it.each(
    ["completed", "delivery_started", "native-started", "native-sent", "delivered"].flatMap(
      (stage) => [false, true].map((after) => ({ stage, after })),
    ),
  )(
    "retains proof at $stage publication (after=$after) without replay",
    async ({ stage, after }) => {
      const f = fixture();
      const first = f.start();
      first.state.saveTurn(receipt());
      Object.assign(fault, {
        file: first.state.filePath,
        stage,
        after,
        fired: false,
      });
      await first.manager.catchUp();
      await vi.waitFor(() => expect(fault.fired).toBe(true));
      await vi.waitFor(() =>
        expect(f.logger.error).toHaveBeenCalledWith(
          stage === "delivered" && after ? "turn.failed" : "turn.drain_failed",
          expect.anything(),
        ),
      );
      // close stops the old owner even when its lease cleanup cannot be written.
      await first.manager.close().catch(() => {});
      const published = createStateStore(f.dir).getTurn("receipt");
      if (!published) throw new Error("The durable source receipt was lost");
      const acceptedBeforeCrash = ["native-sent", "delivered"].includes(stage) ? 1 : 0;
      expect(f.identity.sendIMessage).toHaveBeenCalledTimes(acceptedBeforeCrash);
      if (stage === "completed")
        expect(published.output).toBe(after ? "Saved native answer" : undefined);
      if (stage === "delivered" && after)
        expect(published.deliveryMessageId).toBe("accepted-output");
      const nativeProof = createStateStore(f.dir).read().imessageSends;
      fault.file = "";
      // Model the dead process lease expiring; no delivery/history evidence is changed.
      createStateStore(f.dir).updateTurn("receipt", { leaseUntil: 0 });
      const safe = stage === "completed" || (stage === "delivery_started" && !after);
      for (let restart = 0; restart < 2; restart++) {
        const next = f.start();
        await next.manager.catchUp();
        await vi.waitFor(() =>
          expect(next.state.getTurn("receipt")?.state).toBe(
            safe || (stage === "delivered" && after) ? "delivered" : "failed",
          ),
        );
        expect(f.identity.sendIMessage).toHaveBeenCalledTimes(acceptedBeforeCrash + Number(safe));
        expect(f.opencode.session.promptAsync).not.toHaveBeenCalled();
        expect(next.state.getTurn("receipt")).toMatchObject({
          id: "receipt",
          messageID: "native-prompt",
        });
        if (!safe) expect(next.state.read().imessageSends).toEqual(nativeProof);
        if (stage === "delivered" && after)
          expect(next.state.getTurn("receipt")?.deliveryMessageId).toBe("accepted-output");
        await next.manager.close();
      }
      if (safe)
        expect(f.identity.sendIMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: "conversation",
            replyToMessageId: "source",
            text: "Saved native answer",
          }),
        );
    },
  );

  it.each([false, true])(
    "preserves legacy state through partial publication and two upgrades (after=%s)",
    (after) => {
      const f = fixture();
      const state = createStateStore(f.dir);
      const legacy = {
        sessions: { conversation: "old-native-session" },
        tunnelId: "retained-tunnel",
        permissions: {
          old: {
            permissionID: "old",
            sessionID: "old-native-session",
            chatKey: "conversation",
            title: "Existing permission",
            state: "pending",
            deadline: 1,
          },
        },
        unrelatedExtension: { keep: true },
      };
      fs.writeFileSync(state.filePath, JSON.stringify(legacy));
      Object.assign(fault, {
        file: state.filePath,
        stage: "completed",
        after,
        fired: false,
      });
      expect(() =>
        state.saveTurn({
          ...receipt(),
          state: "completed",
          output: "Saved native answer",
        }),
      ).toThrow("publication failure");
      fault.file = "";
      // A leftover partial temporary file cannot replace the last atomic checkpoint.
      fs.writeFileSync(`${state.filePath}.interrupted.tmp`, '{"turns":');
      for (let restart = 0; restart < 2; restart++) {
        const reopened = createStateStore(f.dir);
        reopened.update({});
        expect(reopened.read()).toMatchObject(legacy);
        expect(Boolean(reopened.getTurn("receipt"))).toBe(after);
        expect(reopened.listPermissions()).toEqual([legacy.permissions.old]);
        expect(reopened.getSession("conversation")).toBe("old-native-session");
      }
    },
  );

  it("retains a saved answer and old permission while disabled across two restarts", async () => {
    const f = fixture();
    const state = createStateStore(f.dir);
    state.saveTurn({
      ...receipt(),
      state: "completed",
      output: "Saved native answer",
    });
    const permission = {
      permissionID: "old",
      sessionID: "native-session",
      chatKey: "other-conversation",
      title: "Existing permission",
      state: "pending" as const,
      deadline: 1,
    };
    state.savePermission(permission);
    f.config.gateway.imessageThreadedReplies = false;
    for (let restart = 0; restart < 2; restart++) {
      const next = f.start();
      await next.manager.catchUp();
      expect(next.state.getTurn("receipt")?.state).toBe("completed");
      expect(next.state.listPermissions()).toEqual([permission]);
      expect(f.identity.sendIMessage).not.toHaveBeenCalled();
      expect(f.opencode.session.promptAsync).not.toHaveBeenCalled();
      await next.manager.close();
    }
    f.config.gateway.imessageThreadedReplies = true;
    const enabled = f.start();
    await enabled.manager.catchUp();
    await vi.waitFor(() => expect(enabled.state.getTurn("receipt")?.state).toBe("delivered"));
    expect(f.identity.sendIMessage).toHaveBeenCalledTimes(1);
    expect(f.opencode.session.promptAsync).not.toHaveBeenCalled();
    expect(enabled.state.listPermissions()).toEqual([permission]);
  });
});
