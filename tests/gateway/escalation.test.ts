// Permission escalation: reply parsing, session ownership gating, response
// relay, timeout fallback, and per-permission in-flight dedupe.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EscalationDeps, PendingPermission } from "../../src/gateway/escalation.js";
import { createEscalationBridge, parsePermissionReply } from "../../src/gateway/escalation.js";
import { subscribePermissionEvents } from "../../src/gateway/events.js";
import { createStateStore } from "../../src/gateway/state.js";

const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
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

  it("retains an uncertain persisted response without prompting or replaying its POST", async () => {
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
    expect(deps.opencode.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
    expect(deps.state.listPermissions()).toEqual([
      expect.objectContaining({ state: "responding", response: "always" }),
    ]);
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
    const failed = expect(closed).rejects.toThrow(/shutdown deadline/i);
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

it("persists and drains a late owned ask while another shutdown rejection is held", async () => {
  let firstPost: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    firstPost = resolve;
  });
  const deps = makeDeps({
    relay: {
      ask: vi.fn(
        (_chat, _text, _target, options) =>
          new Promise<string | undefined>((resolve) =>
            options?.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
          ),
      ),
    },
  });
  const owner = {
    turnId: "turn",
    ownerId: "owner",
    messageID: "source",
    toolMessageID: "assistant",
    sessionID: perm.sessionID,
    chatKey: "ck",
  };
  deps.resolveOwner = async () => owner;
  deps.ownerCurrent = () => true;
  deps.opencode.postSessionIdPermissionsPermissionId.mockImplementation(async (args: any) => {
    if (args.path.permissionID === perm.permissionID) await held;
    return { data: true };
  });
  const bridge = createEscalationBridge(deps);
  const active = bridge.handlePermission(perm);
  await vi.waitFor(() => expect(deps.relay.ask).toHaveBeenCalledTimes(1));
  const close = bridge.close();
  await vi.waitFor(() =>
    expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1),
  );
  await bridge.handlePermission({ ...perm, permissionID: "late" });
  expect(deps.relay.ask).toHaveBeenCalledTimes(1);
  expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(2);
  expect(deps.state.listPermissions().map((p) => p.permissionID)).toEqual([perm.permissionID]);
  firstPost();
  await Promise.all([close, active, bridge.detach()]);
  expect(deps.state.listPermissions()).toEqual([]);
});

it("tracks an ownership read already in progress when shutdown starts", async () => {
  let release: (value: any) => void = () => {};
  const deps = makeDeps({
    resolveOwner: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    ownerCurrent: () => true,
  });
  const bridge = createEscalationBridge(deps);
  const handling = bridge.handlePermission(perm);
  let completed = false;
  const close = bridge.close().then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  release({
    turnId: "turn",
    ownerId: "owner",
    messageID: "source",
    toolMessageID: "assistant",
    sessionID: perm.sessionID,
    chatKey: "ck",
  });
  await Promise.all([handling, close]);
  expect(deps.relay.ask).not.toHaveBeenCalled();
  expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1);
  expect(deps.state.listPermissions()).toEqual([]);
});

it("inventory admission is finite while a human answer remains pending and duplicate events do not relay twice", async () => {
  const deps = makeDeps({
    inventory: async () => [perm],
    relay: {
      ask: vi.fn(
        (_chat, _text, _target, options) =>
          new Promise<string | undefined>((resolve) =>
            options?.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
          ),
      ),
    },
  });
  const bridge = createEscalationBridge(deps);
  await bridge.reconcile(true);
  expect(deps.relay.ask).toHaveBeenCalledTimes(1);
  await bridge.reconcile(true);
  expect(deps.relay.ask).toHaveBeenCalledTimes(1);
  bridge.resolved(perm.permissionID);
  await bridge.close();
  expect(deps.opencode.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
});

it.each(["once", "always", "reject"] as const)(
  "native inventory never overrides or replays an uncertain %s response",
  async (response) => {
    const deps = makeDeps({ inventory: async () => [perm] });
    deps.state.savePermission({
      ...perm,
      chatKey: "ck",
      deadline: Date.now() + 1000,
      state: "responding",
      response,
    });
    const bridge = createEscalationBridge(deps);
    await bridge.reconcile(true);
    await bridge.catchUp();
    await bridge.close();
    expect(deps.opencode.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
    expect(deps.relay.ask).not.toHaveBeenCalled();
    expect(deps.state.listPermissions()).toEqual([
      expect.objectContaining({ state: "responding", response }),
    ]);
  },
);

it("keeps inventory failures unready and retries on a later attachment without clearing retained records", async () => {
  const inventory = vi
    .fn()
    .mockRejectedValueOnce(new Error("synthetic inventory unavailable"))
    .mockResolvedValueOnce([]);
  const deps = makeDeps({ inventory });
  deps.state.savePermission({
    ...perm,
    chatKey: "ck",
    deadline: Date.now(),
    state: "responding",
    response: "once",
  });
  const bridge = createEscalationBridge(deps);
  await expect(bridge.reconcile(true)).rejects.toThrow("synthetic inventory unavailable");
  expect(deps.state.read().permissionInventory).toEqual({ ready: false });
  expect(deps.state.listPermissions()).toHaveLength(1);
  await bridge.reconcile(true);
  expect(deps.state.read().permissionInventory).toEqual({ ready: true });
  expect(deps.state.listPermissions()).toHaveLength(1);
  expect(deps.opencode.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
});

it("a slow inventory owner read cannot overwrite or replay a concurrently uncertain native response", async () => {
  let release: (value: any) => void = () => {};
  const owner = {
    turnId: "turn",
    ownerId: "owner",
    messageID: "source",
    toolMessageID: "assistant",
    sessionID: perm.sessionID,
    chatKey: "ck",
  };
  const resolveOwner = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(owner);
  const deps = makeDeps({ inventory: async () => [perm], resolveOwner, ownerCurrent: () => true });
  deps.opencode.postSessionIdPermissionsPermissionId.mockRejectedValue(
    new Error("Synthetic response outcome unknown"),
  );
  const bridge = createEscalationBridge(deps);
  const recovering = bridge.reconcile(true);
  await vi.waitFor(() => expect(resolveOwner).toHaveBeenCalledTimes(1));
  await bridge.handlePermission(perm);
  expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1);
  expect(deps.state.listPermissions()[0]).toMatchObject({ state: "responding", response: "once" });
  release(owner);
  await recovering;
  expect(deps.relay.ask).toHaveBeenCalledTimes(1);
  expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1);
  expect(deps.state.listPermissions()[0]).toMatchObject({ state: "responding", response: "once" });
  await bridge.close();
});

it("a detached bridge's late inventory failure cannot overwrite replacement readiness", async () => {
  let reject: (reason: unknown) => void = () => {};
  const deps = makeDeps({
    inventory: () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  });
  const old = createEscalationBridge(deps);
  const reading = old.reconcile(true);
  const rejected = expect(reading).rejects.toThrow("old inventory failed");
  await old.close();
  await old.detach();
  const current = createEscalationBridge({ ...deps, inventory: async () => [] });
  await current.reconcile(true);
  expect(deps.state.read().permissionInventory).toEqual({ ready: true });
  reject(new Error("old inventory failed"));
  await rejected;
  expect(deps.state.read().permissionInventory).toEqual({ ready: true });
  await current.close();
});

it("a failed durable admission is unready, sends nothing, and can be recovered from native inventory", async () => {
  const deps = makeDeps({ inventory: async () => [perm] });
  const original = deps.state.savePermission.bind(deps.state);
  const saving = vi.spyOn(deps.state, "savePermission").mockImplementationOnce(() => {
    throw new Error("Synthetic journal unavailable");
  });
  const bridge = createEscalationBridge(deps);
  await expect(bridge.reconcile(true)).rejects.toThrow("not confirmed");
  expect(deps.state.read().permissionInventory).toEqual({ ready: false });
  expect(deps.relay.ask).not.toHaveBeenCalled();
  expect(deps.opencode.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
  saving.mockImplementation(original);
  await bridge.reconcile(true);
  await vi.waitFor(() =>
    expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1),
  );
  expect(deps.state.listPermissions()).toEqual([]);
  await bridge.close();
});

it("a timed-out old owner lookup cannot overwrite a replacement bridge's readiness", async () => {
  let rejectOwner: (reason: unknown) => void = () => {};
  const deps = makeDeps({
    inventory: async () => [perm],
    resolveOwner: () =>
      new Promise((_, fail) => {
        rejectOwner = fail;
      }),
    ownerCurrent: () => true,
  });
  const old = createEscalationBridge(deps);
  const reading = old.reconcile(true);
  const readFailure = expect(reading).rejects.toThrow("not confirmed");
  await Promise.resolve();
  await Promise.resolve();
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  try {
    const closing = old.close();
    const closeFailure = expect(closing).rejects.toThrow(/deadline/i);
    deadline.abort();
    await closeFailure;
    await expect(old.detach()).rejects.toThrow();
    const current = createEscalationBridge({ ...deps, inventory: async () => [] });
    await current.reconcile(true);
    expect(deps.state.read().permissionInventory).toEqual({ ready: true });
    rejectOwner(new Error("old owner read failed"));
    await readFailure;
    expect(deps.state.read().permissionInventory).toEqual({ ready: true });
    await current.close();
  } finally {
    timeout.mockRestore();
  }
});

it("an owned permission without a reply route cannot inherit a newer mutable chat destination", async () => {
  const owner = {
    turnId: "turn",
    ownerId: "owner",
    messageID: "source",
    toolMessageID: "assistant",
    sessionID: perm.sessionID,
    chatKey: "ck",
  };
  const deps = makeDeps({ resolveOwner: async () => owner, ownerCurrent: () => true });
  deps.state.setReplyTarget("ck", {
    channel: "email",
    to: "newer@example.com",
    sender: "newer@example.com",
  });
  await createEscalationBridge(deps).handlePermission(perm);
  expect(deps.relay.ask).toHaveBeenCalledWith(
    "ck",
    expect.any(String),
    undefined,
    expect.any(Object),
  );
});

it.each([false, undefined])("retains an owned response when the native ACK is %s", async (data) => {
  const owner = {
    turnId: "turn",
    ownerId: "owner",
    messageID: "source",
    toolMessageID: "assistant",
    sessionID: perm.sessionID,
    chatKey: "ck",
  };
  const deps = makeDeps({
    resolveOwner: async () => owner,
    ownerCurrent: () => true,
    inventory: async () => [perm],
  });
  deps.opencode.postSessionIdPermissionsPermissionId.mockResolvedValue({ data } as any);
  const bridge = createEscalationBridge(deps);
  await bridge.handlePermission(perm);
  await bridge.reconcile(true);
  await bridge.close();
  expect(deps.opencode.postSessionIdPermissionsPermissionId).toHaveBeenCalledTimes(1);
  expect(deps.state.listPermissions()).toEqual([
    expect.objectContaining({ state: "responding", response: "once" }),
  ]);
});

function attachedIdleBridge(inventory: EscalationDeps["inventory"]) {
  const deps = makeDeps({ inventory });
  const bridge = createEscalationBridge(deps);
  const subscribe = vi.fn(async ({ signal }: { signal: AbortSignal }) => ({
    stream: (async function* () {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    })(),
  }));
  const listener = subscribePermissionEvents(
    { event: { subscribe } } as never,
    bridge,
    deps.logger,
    deps.directory,
  );
  return { deps, bridge, subscribe, listener };
}

it("retries an idle transient inventory failure without replacing the healthy SSE attachment", async () => {
  vi.useFakeTimers();
  const inventory = vi
    .fn()
    .mockRejectedValueOnce(new Error("synthetic unavailable"))
    .mockResolvedValue([]);
  const d = attachedIdleBridge(inventory);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(d.deps.state.read().permissionInventory).toEqual({ ready: false });
    expect(d.deps.state.listTurns()).toEqual([]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(inventory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(d.deps.state.read().permissionInventory).toEqual({ ready: true });
    await vi.advanceTimersByTimeAsync(20000);
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(d.subscribe).toHaveBeenCalledTimes(1);
    expect(d.deps.relay.ask).not.toHaveBeenCalled();
    expect(d.deps.opencode.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
  } finally {
    await d.bridge.close();
    d.listener.close();
  }
});

it("close cancels an idle inventory retry without changing replacement readiness", async () => {
  vi.useFakeTimers();
  const inventory = vi.fn().mockRejectedValue(new Error("synthetic unavailable"));
  const d = attachedIdleBridge(inventory);
  await vi.advanceTimersByTimeAsync(0);
  expect(inventory).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await d.bridge.close();
  d.listener.close();
  d.deps.state.update({ permissionInventory: { ready: true } });
  await vi.advanceTimersByTimeAsync(20000);
  expect(inventory).toHaveBeenCalledTimes(1);
  expect(d.subscribe).toHaveBeenCalledTimes(1);
  expect(d.deps.state.read().permissionInventory).toEqual({ ready: true });
  expect(vi.getTimerCount()).toBe(0);
});

it("coalesces inventory retry and forced recovery reads while one read is pending", async () => {
  vi.useFakeTimers();
  let release: (value: PendingPermission[]) => void = () => {};
  const inventory = vi
    .fn()
    .mockRejectedValueOnce(new Error("synthetic unavailable"))
    .mockImplementationOnce(
      () =>
        new Promise<PendingPermission[]>((resolve) => {
          release = resolve;
        }),
    );
  const d = attachedIdleBridge(inventory);
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(inventory).toHaveBeenCalledTimes(2);
    const forced = d.bridge.reconcile(true);
    const duplicate = d.bridge.reconcile(true);
    expect(forced).toBe(duplicate);
    await vi.advanceTimersByTimeAsync(10000);
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(d.deps.state.read().permissionInventory).toEqual({ ready: false });
    release([]);
    await forced;
    expect(d.deps.state.read().permissionInventory).toEqual({ ready: true });
    await vi.advanceTimersByTimeAsync(20000);
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(d.subscribe).toHaveBeenCalledTimes(1);
  } finally {
    await d.bridge.close();
    d.listener.close();
  }
});
