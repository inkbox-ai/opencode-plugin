// Permission escalation: reply parsing, session ownership gating, response
// relay, timeout fallback, and per-permission in-flight dedupe.
import { describe, expect, it, vi } from "vitest";
import type { EscalationDeps, PendingPermission } from "../../src/gateway/escalation.js";
import { createEscalationBridge, parsePermissionReply } from "../../src/gateway/escalation.js";

function makeDeps(over: Partial<EscalationDeps> = {}): EscalationDeps & {
  opencode: { postSessionIdPermissionsPermissionId: ReturnType<typeof vi.fn> };
} {
  const opencode = { postSessionIdPermissionsPermissionId: vi.fn(async () => ({})) };
  return {
    opencode: opencode as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    relay: { ask: vi.fn(async () => "1") },
    chatKeyForSession: vi.fn(() => "ck"),
    timeoutMs: 0,
    directory: "/proj",
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

    expect(deps.relay.ask).toHaveBeenCalledWith("ck", expect.stringContaining("Delete 3 files"));
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
});
