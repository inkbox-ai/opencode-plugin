// Permission escalation: reply parsing, session ownership gating, response
// relay, timeout fallback, and per-permission in-flight dedupe.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EscalationDeps, PendingPermission } from "../../src/gateway/escalation.js";
import { createEscalationBridge, parsePermissionReply } from "../../src/gateway/escalation.js";
import { createStateStore } from "../../src/gateway/state.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDeps(over: Partial<EscalationDeps> = {}): EscalationDeps & {
  opencode: { postSessionIdPermissionsPermissionId: ReturnType<typeof vi.fn> };
} {
  const opencode = { postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-escalation-"));
  dirs.push(dir);
  return {
    opencode: opencode as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    relay: { ask: vi.fn(async () => "1") },
    chatKeyForSession: vi.fn(() => "ck"),
    timeoutMs: 0,
    directory: "/proj",
    state: createStateStore(dir),
    ...over,
  } as never;
}

const perm: PendingPermission = {
  permissionID: "perm-1",
  sessionID: "sess-1",
  title: "Delete 3 files",
};

describe("parsePermissionReply", () => {
  it("maps affirmatives to once", () => {
    for (const v of ["1", "yes", "allow", "ok", "sure", "go ahead"]) {
      expect(parsePermissionReply(v)).toBe("once");
    }
  });

  it("maps always variants to always", () => {
    for (const v of ["2", "always", "allow always", "yes always"]) {
      expect(parsePermissionReply(v)).toBe("always");
    }
  });

  it("rejects declines, gibberish, and empty replies", () => {
    for (const v of ["3", "no", "nope", "asdf", ""]) {
      expect(parsePermissionReply(v)).toBe("reject");
    }
  });
});

describe("handlePermission", () => {
  it("does not respond for a session it does not own", async () => {
    const deps = makeDeps({ chatKeyForSession: vi.fn(() => undefined) });
    const bridge = createEscalationBridge(deps);

    await bridge.handlePermission(perm);

    expect(deps.relay.ask).not.toHaveBeenCalled();
    expect(deps.opencode.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
  });

  it("relays the titled prompt and posts the parsed response for a known session", async () => {
    const deps = makeDeps({ relay: { ask: vi.fn(async () => "2") } });
    const bridge = createEscalationBridge(deps);

    await bridge.handlePermission(perm);

    expect(deps.relay.ask).toHaveBeenCalledWith(
      "ck",
      expect.stringContaining("Delete 3 files"),
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: expect.any(Number) }),
    );
    expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
      path: { id: "sess-1", permissionID: "perm-1" },
      query: { directory: "/proj" },
      body: { response: "always" },
    });
  });

  it("declines when the relay resolves undefined (timeout)", async () => {
    const deps = makeDeps({ relay: { ask: vi.fn(async () => undefined) } });
    const bridge = createEscalationBridge(deps);

    await bridge.handlePermission(perm);

    expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
      path: { id: "sess-1", permissionID: "perm-1" },
      query: { directory: "/proj" },
      body: { response: "reject" },
    });
  });

  it("asks once when the same permission is handled twice while in flight", async () => {
    let release: (v: string) => void = () => {};
    const ask = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const deps = makeDeps({ relay: { ask } });
    const bridge = createEscalationBridge(deps);

    const first = bridge.handlePermission(perm);
    const second = bridge.handlePermission(perm);
    await Promise.resolve();

    expect(ask).toHaveBeenCalledTimes(1);

    release("1");
    await Promise.all([first, second]);
    expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1);
  });

  it("recovers a persisted permission after restart", async () => {
    const deps = makeDeps({ relay: { ask: vi.fn(async () => "1") }, timeoutMs: 60_000 });
    deps.state.savePermission({
      permissionID: perm.permissionID,
      sessionID: perm.sessionID,
      chatKey: "ck",
      title: perm.title,
      deadline: Date.now() + 60_000,
      state: "relayed",
    });

    await createEscalationBridge(deps).catchUp();

    expect(deps.relay.ask).toHaveBeenCalledOnce();
    expect(deps.state.listPermissions()).toEqual([]);
  });

  it("retains a permission when the response fails", async () => {
    const deps = makeDeps();
    deps.opencode.postSessionIdPermissionsPermissionId.mockResolvedValueOnce({
      error: { name: "Unavailable" },
    });

    await createEscalationBridge(deps).handlePermission(perm);

    expect(deps.state.listPermissions()).toHaveLength(1);
  });

  it("rejects an expired permission without relaying it again", async () => {
    const deps = makeDeps({ timeoutMs: 60_000 });
    deps.state.savePermission({
      permissionID: perm.permissionID,
      sessionID: perm.sessionID,
      chatKey: "ck",
      title: perm.title,
      deadline: Date.now() - 1,
      state: "relayed",
    });

    await createEscalationBridge(deps).catchUp();

    expect(deps.relay.ask).not.toHaveBeenCalled();
    expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: "reject" } }),
    );
  });

  it("retries a persisted response without prompting again", async () => {
    const deps = makeDeps({ timeoutMs: 60_000 });
    deps.state.savePermission({
      permissionID: perm.permissionID,
      sessionID: perm.sessionID,
      chatKey: "ck",
      title: perm.title,
      deadline: Date.now() + 60_000,
      state: "responding",
      response: "always",
    });

    await createEscalationBridge(deps).catchUp();

    expect(deps.relay.ask).not.toHaveBeenCalled();
    expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
      expect.objectContaining({ body: { response: "always" } }),
    );
  });
});

it("falls back to a capture chat route and persists it with the permission", async () => {
  const deps = makeDeps();
  const target = {
    channel: "email" as const,
    sender: "person@example.com",
    messageId: "inbound-parent",
  };
  deps.state.setReplyTarget("ck", target);
  deps.state.saveTurn({
    id: "capture",
    messageID: "capture",
    chatKey: "ck",
    sessionID: perm.sessionID,
    state: "submitted",
    kind: "capture",
    text: "task",
    deliver: false,
    createdAt: 1,
    updatedAt: 1,
  });
  const ask = vi.fn(async () => {
    expect(deps.state.listPermissions()[0].replyTarget).toEqual(target);
    return "1";
  });
  deps.relay.ask = ask;
  await createEscalationBridge(deps).handlePermission(perm);
  expect(ask).toHaveBeenCalledWith(
    "ck",
    expect.any(String),
    target,
    expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: expect.any(Number) }),
  );
});

it("does not reject or recreate a permission already resolved in the native host", async () => {
  let finish: (v: string | undefined) => void = () => {};
  const deps = makeDeps({
    relay: {
      ask: vi.fn(
        (_key, _prompt, _target, options) =>
          new Promise<string | undefined>((resolve) => {
            finish = resolve;
            options?.signal.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      ),
    },
  });
  const bridge = createEscalationBridge(deps);
  const handling = bridge.handlePermission(perm);
  expect(bridge.isInFlight(perm.permissionID)).toBe(true);
  bridge.resolved(perm.permissionID);
  finish("2");
  await handling;
  await bridge.handlePermission(perm);
  expect(deps.state.listPermissions()).toEqual([]);
  expect(deps.opencode.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
  expect(deps.relay.ask).toHaveBeenCalledOnce();
});

it("retires only its live owned asks on idempotent shutdown and aborts the relay", async () => {
  const deps = makeDeps({
    relay: {
      ask: vi.fn(
        (_k, _p, _t, options) =>
          new Promise<string | undefined>((resolve) => {
            options?.signal.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      ),
    },
  });
  deps.state.savePermission({
    ...perm,
    permissionID: "unrelated-stored",
    chatKey: "ck",
    state: "pending",
    deadline: Date.now() + 10000,
  });
  const bridge = createEscalationBridge(deps);
  const handling = bridge.handlePermission(perm);
  const closed = bridge.close();
  expect(bridge.close()).toBe(closed);
  await closed;
  await handling;
  expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      path: { id: perm.sessionID, permissionID: perm.permissionID },
      body: { response: "reject" },
      signal: expect.any(AbortSignal),
    }),
  );
  expect(deps.state.listPermissions().map((p) => p.permissionID)).toEqual(["unrelated-stored"]);
});

it("does not conflict with an approval POST already in flight during shutdown", async () => {
  let finish: (result: unknown) => void = () => {};
  const deps = makeDeps();
  deps.opencode.postSessionIdPermissionsPermissionId.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const bridge = createEscalationBridge(deps);
  const handling = bridge.handlePermission(perm);
  await vi.waitFor(() =>
    expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce(),
  );
  await bridge.close();
  expect(deps.state.listPermissions()[0]).toMatchObject({ state: "responding", response: "once" });
  expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledOnce();
  finish({});
  await handling;
});

it("keeps failed shutdown rejection durable while attempting the other owned cleanup", async () => {
  const deps = makeDeps({
    relay: {
      ask: vi.fn(
        (_k, _p, _t, options) =>
          new Promise<string | undefined>((resolve) => {
            options?.signal.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      ),
    },
  });
  deps.opencode.postSessionIdPermissionsPermissionId.mockRejectedValueOnce(
    new Error("Synthetic native failure"),
  );
  const bridge = createEscalationBridge(deps);
  const handling = [
    bridge.handlePermission(perm),
    bridge.handlePermission({ ...perm, permissionID: "second" }),
  ];
  await expect(bridge.close()).rejects.toThrow("Synthetic native failure");
  await Promise.all(handling);
  expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(2);
  expect(createStateStore(path.dirname(deps.state.filePath)).listPermissions()).toEqual([
    expect.objectContaining({
      permissionID: perm.permissionID,
      state: "responding",
      response: "reject",
    }),
  ]);
});

it("does not decline an ask whose session ownership changed before close", async () => {
  const owner = vi.fn(() => "ck");
  const deps = makeDeps({
    chatKeyForSession: owner,
    relay: {
      ask: vi.fn(
        (_k, _p, _t, options) =>
          new Promise<string | undefined>((resolve) => {
            options?.signal.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      ),
    },
  });
  const bridge = createEscalationBridge(deps);
  const handling = bridge.handlePermission(perm);
  owner.mockReturnValue("new-owner");
  await bridge.close();
  await handling;
  expect(deps.opencode.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
  expect(deps.state.listPermissions()[0].state).toBe("relayed");
});

it("bounds an unresponsive native shutdown POST and retains its durable reject", async () => {
  const timeout = new AbortController();
  const makeTimeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  const deps = makeDeps({
    relay: {
      ask: vi.fn(
        (_k, _p, _t, options) =>
          new Promise<string | undefined>((resolve) => {
            options?.signal.addEventListener("abort", () => resolve(undefined), { once: true });
          }),
      ),
    },
  });
  deps.opencode.postSessionIdPermissionsPermissionId.mockImplementation(
    (args: any) =>
      new Promise((_resolve, reject) => {
        args.signal.addEventListener(
          "abort",
          () => reject(new Error("Synthetic shutdown deadline")),
          { once: true },
        );
      }),
  );
  const bridge = createEscalationBridge(deps);
  const handling = bridge.handlePermission(perm);
  try {
    const closed = bridge.close();
    const failed = expect(closed).rejects.toThrow("Synthetic shutdown deadline");
    expect(makeTimeout).toHaveBeenCalledWith(5000);
    timeout.abort();
    await failed;
    await handling;
    expect(deps.state.listPermissions()[0]).toMatchObject({
      state: "responding",
      response: "reject",
    });
  } finally {
    makeTimeout.mockRestore();
  }
});

it.each([{ data: false }, {}])(
  "retains the durable shutdown rejection without a positive ACK (%j)",
  async (reply) => {
    const deps = makeDeps({
      relay: {
        ask: vi.fn(
          (_k, _p, _t, options) =>
            new Promise<string | undefined>((resolve) => {
              options?.signal.addEventListener("abort", () => resolve(undefined), { once: true });
            }),
        ),
      },
    });
    deps.opencode.postSessionIdPermissionsPermissionId.mockResolvedValue(reply);
    const bridge = createEscalationBridge(deps);
    const handling = bridge.handlePermission(perm);
    await expect(bridge.close()).rejects.toThrow("not acknowledged");
    await handling;
    expect(deps.state.listPermissions()[0]).toMatchObject({
      state: "responding",
      response: "reject",
    });
  },
);
