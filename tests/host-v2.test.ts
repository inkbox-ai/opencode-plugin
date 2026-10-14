import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredPackages, installWrapper, wrapperSource } from "../src/cli/wrappers.js";
import { resolveConfig } from "../src/config.js";
import { createStateStore } from "../src/gateway/state.js";
import { registerGatewayOwner } from "../src/host/gateway-owner.js";
import { bindHostState } from "../src/host/state.js";
import { createV2Host } from "../src/host/v2-client.js";
import type { V2Client } from "../src/host/v2-connection.js";
import { normalizeHistory, projectHistory, readHistory } from "../src/host/v2-history.js";
import { configurationKey } from "../src/host/v2-rpc.js";
import plugin from "../src/v2.js";

const dirs: string[] = [];
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "inkbox-host-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("V2 history", () => {
  it("returns JSON-safe hello output before the first gateway startup", async () => {
    vi.stubEnv("INKBOX_OPENCODE_HOME", temporary());
    let methods: any;
    try {
      await plugin.setup({
        options: {},
        location: { directory: "/fixture" },
        storage: { get: async () => undefined, set: async () => {} },
        tool: { transform: async () => {}, list: async () => [], hook: async () => {} },
        session: { hook: async () => {} },
        rpc: {
          register: async (_contract: unknown, handlers: unknown) => {
            methods = handlers;
          },
        },
      } as any);
      const result = await methods.hello();
      expect(result).not.toHaveProperty("stateProbe");
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("preserves completed tool text for delivery detection", () => {
    const messages = normalizeHistory(
      [
        {
          id: "msg_answer",
          type: "assistant",
          time: { created: 2 },
          content: [
            {
              type: "tool",
              id: "call_send",
              name: "inkbox_send_email",
              state: {
                status: "completed",
                input: {},
                content: [{ type: "text", text: "Sent email id=sent" }],
              },
            },
          ],
        },
      ] as any,
      "ses_test",
    );
    expect(messages[0].parts[0].state.output).toBe("Sent email id=sent");
  });
  const user = (id: string) => ({ id, type: "user", text: id, time: { created: 1 } });
  const assistant = (id: string, finish: string) => ({
    id,
    type: "assistant",
    finish,
    content: [{ type: "text", text: id }],
    time: { created: 2 },
  });
  it("retains turn linkage through compaction and tool continuations", () => {
    const history = normalizeHistory(
      [
        user("msg_first"),
        assistant("msg_tool", "tool-calls"),
        { id: "msg_checkpoint", type: "compaction" },
        assistant("msg_answer", "stop"),
        user("msg_second"),
        assistant("msg_second_answer", "stop"),
      ] as any,
      "ses_test",
    );
    expect(history.filter((m) => m.info.role === "assistant").map((m) => m.info.parentID)).toEqual([
      "msg_first",
      "msg_first",
      "msg_second",
    ]);
  });
  it("does not assign ambiguous merged input to either source", () => {
    const history = normalizeHistory(
      [user("msg_first"), user("msg_second"), assistant("msg_answer", "stop")] as any,
      "ses_test",
    );
    expect(history.at(-1)?.info.parentID).toBeUndefined();
  });
  it.each(["synthetic", "shell", "skill", "compaction"])(
    "does not attribute a later %s run to an earlier input",
    (type) => {
      const projection = projectHistory(
        [
          user("msg_first"),
          assistant("msg_answer", "stop"),
          { id: "msg_notice", type },
          assistant("msg_background", "stop"),
        ] as any,
        "ses_test",
      );
      expect(projection.messages.at(-1)?.info.parentID).toBeUndefined();
      expect(projection.parentID).toBeUndefined();
    },
  );
  it("reports a failed merged run to its waiting inputs without assigning its output", () => {
    const history = normalizeHistory(
      [
        user("msg_first"),
        user("msg_second"),
        { id: "msg_idle", type: "idle", outcome: "failed" },
      ] as any,
      "ses_test",
    );
    expect(history.filter((m) => m.info.error).map((m) => m.info.parentID)).toEqual([
      "msg_first",
      "msg_second",
    ]);
  });
  it("reads beyond the first history page without repeating order with a cursor", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [user("msg_old")], cursor: { next: "page2" } })
      .mockResolvedValueOnce({ data: [assistant("msg_answer", "stop")], cursor: { next: "end" } })
      .mockResolvedValueOnce({ data: [], cursor: {} });
    expect(await readHistory({ message: { list } } as any, "ses_test")).toHaveLength(2);
    expect(list.mock.calls[1][0]).toEqual({ sessionID: "ses_test", limit: 200, cursor: "page2" });
  });
});

describe("host migration", () => {
  it("retains unfinished records when switching hosts", () => {
    const state = createStateStore(temporary());
    state.setSession("contact", "ses_old");
    state.saveTurn({ id: "turn", sessionID: "ses_old", state: "submitted" } as any);
    expect(() => bindHostState(state, 2, "new")).toThrow("another OpenCode host");
    expect(state.getSession("contact")).toBe("ses_old");
    expect(state.getTurn("turn")?.state).toBe("submitted");
  });
  it("archives completed session mappings on upgrade and downgrade", () => {
    const state = createStateStore(temporary());
    state.setSession("contact", "ses_old");
    bindHostState(state, 2, "new");
    expect(state.read().previousHostSessions).toEqual({ contact: "ses_old" });
    state.setSession("contact", "ses_new");
    bindHostState(state, 1);
    expect(state.getSession("contact")).toBeUndefined();
    expect(state.read().previousHostSessions).toEqual({ contact: "ses_new" });
  });
  it("allows finished captures and settled failures to move hosts", () => {
    const state = createStateStore(temporary());
    state.setSession("contact", "ses_old");
    state.saveTurn({
      id: "capture",
      sessionID: "ses_old",
      state: "completed",
      deliver: false,
    } as any);
    state.saveTurn({
      id: "failed",
      sessionID: "ses_old",
      state: "failed",
      executionFenced: true,
    } as any);
    bindHostState(state, 2, "new");
    expect(state.getTurn("capture")?.state).toBe("completed");
    expect(state.getTurn("failed")?.state).toBe("failed");
  });
  it("retains unconfirmed submissions even without a session mapping", () => {
    const state = createStateStore(temporary());
    state.saveTurn({
      id: "failed",
      sessionID: "ses_old",
      state: "failed",
      uncertainStage: "submission",
    } as any);
    expect(() => bindHostState(state, 2, "new")).toThrow("another OpenCode host");
  });
});

describe("wrapper upgrades", () => {
  it("migrates the generated wrapper in both directions", () => {
    const file = join(temporary(), "inkbox.ts");
    writeFileSync(file, wrapperSource(1));
    expect(installWrapper(file, 2)).toBe("updated");
    expect(readFileSync(file, "utf8")).toBe(wrapperSource(2));
    expect(installWrapper(file, 2)).toBe("unchanged");
    expect(installWrapper(file, 1)).toBe("updated");
    expect(readFileSync(file, "utf8")).toBe(wrapperSource(1));
  });
  it("preserves custom options rather than replacing the wrapper", () => {
    const file = join(temporary(), "inkbox.ts");
    const source = wrapperSource(1).replace("inkbox_place_call", "inkbox_credentials_get_secret");
    writeFileSync(file, source);
    expect(installWrapper(file, 2)).toBe("custom");
    expect(readFileSync(file, "utf8")).toBe(source);
  });
  it("does not rewrite custom comments or whitespace inside option values", () => {
    const file = join(temporary(), "inkbox.ts");
    for (const source of [
      `// Custom setup notes\n${wrapperSource(1)}`,
      wrapperSource(1).replace("inkbox_place_call", "inkbox_ place_call"),
    ]) {
      writeFileSync(file, source);
      expect(installWrapper(file, 2)).toBe("custom");
      expect(readFileSync(file, "utf8")).toBe(source);
    }
  });
  it("recognizes explicit package entries in JSONC without matching comments", () => {
    const dir = temporary();
    const file = join(dir, "opencode.jsonc");
    writeFileSync(file, '{ // @inkbox/opencode-plugin\n "plugins": [] }');
    expect(configuredPackages(dir)).toEqual([]);
    writeFileSync(
      file,
      '{ "plugins": [{ "package": "@inkbox/opencode-plugin/v2", "options": {} }], }',
    );
    expect(configuredPackages(dir)).toEqual([file]);
  });
});

describe("V2 cancellation", () => {
  it("cancels admitted input as well as active execution", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn().mockResolvedValue({ interrupted: false });
    const native = {
      session: {
        inbox: {
          list: vi
            .fn()
            .mockResolvedValueOnce([{ id: "msg_pending" }])
            .mockResolvedValueOnce([]),
          cancel,
        },
        interrupt,
        wait: vi.fn().mockResolvedValue(undefined),
        active: vi.fn().mockResolvedValue({}),
      },
    } as unknown as V2Client;
    const host = createV2Host({ get: async () => native, invalidate() {} }, resolveConfig({}, {}));
    expect((await host.session.abort({ path: { id: "ses_test" } })).data).toBe(true);
    expect(cancel).toHaveBeenCalledWith({ sessionID: "ses_test", inboxID: "msg_pending" });
    expect(interrupt).toHaveBeenCalledWith({ sessionID: "ses_test", resume: false });
  });
  it("does not acknowledge stop while admitted input remains", async () => {
    const native = {
      session: {
        inbox: { list: vi.fn().mockResolvedValue([{ id: "msg_pending" }]), cancel: vi.fn() },
        interrupt: vi.fn(),
        wait: vi.fn(),
        active: vi.fn().mockResolvedValue({}),
      },
    } as unknown as V2Client;
    const host = createV2Host({ get: async () => native, invalidate() {} }, resolveConfig({}, {}));
    await expect(host.session.abort({ path: { id: "ses_test" } })).rejects.toThrow(
      "has not confirmed",
    );
  });
});

describe("gateway location ownership", () => {
  it("keeps one gateway and transfers ownership only after close", async () => {
    const closeFirst = vi.fn().mockResolvedValue(undefined);
    const closeSecond = vi.fn().mockResolvedValue(undefined);
    const first = { directory: "first", start: vi.fn().mockResolvedValue({ close: closeFirst }) };
    const second = {
      directory: "second",
      start: vi.fn().mockResolvedValue({ close: closeSecond }),
    };
    const report = vi.fn();
    const key = temporary();
    const disposeFirst = registerGatewayOwner(key, first, report);
    await vi.waitFor(() => expect(first.start).toHaveBeenCalledTimes(1));
    const disposeSecond = registerGatewayOwner(key, second, report);
    await disposeSecond();
    expect(closeFirst).not.toHaveBeenCalled();
    expect(second.start).not.toHaveBeenCalled();
    const disposeReplacement = registerGatewayOwner(key, second, report);
    await disposeFirst();
    expect(closeFirst).toHaveBeenCalledTimes(1);
    expect(second.start).toHaveBeenCalledTimes(1);
    await disposeReplacement();
    expect(closeSecond).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });
  it("waits for startup before disposing its handle", async () => {
    let started!: (handle: { close(): Promise<void> }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ close(): Promise<void> }>((resolve) => {
          started = resolve;
        }),
    );
    const close = vi.fn().mockResolvedValue(undefined);
    const dispose = registerGatewayOwner(temporary(), { directory: "first", start }, vi.fn());
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const disposed = dispose();
    expect(close).not.toHaveBeenCalled();
    started({ close });
    await disposed;
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("V2 reconnection", () => {
  it("refreshes the connection for a failed read", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce({ reason: "Transport" })
      .mockResolvedValue({ id: "ses_test", location: { directory: "/fixture" } });
    const invalidate = vi.fn();
    const native = { session: { get } } as unknown as V2Client;
    const host = createV2Host({ get: async () => native, invalidate }, resolveConfig({}, {}));
    expect((await host.session.get({ path: { id: "ses_test" } })).data?.id).toBe("ses_test");
    expect(get).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
  it("does not retry an ambiguous prompt submission", async () => {
    const config = resolveConfig({}, {});
    const prompt = vi.fn().mockRejectedValue({ reason: "Transport" });
    const native = {
      rpc: () => ({
        hello: async () => ({ configuration: configurationKey(config) }),
        prepare: async () => ({ ready: true }),
      }),
      agent: { list: async () => ({ data: [{ id: "build", mode: "primary", hidden: false }] }) },
      session: { prompt, switchAgent: vi.fn() },
    } as unknown as V2Client;
    const host = createV2Host({ get: async () => native, invalidate() {} }, config);
    await expect(
      host.session.promptAsync({
        path: { id: "ses_test" },
        query: { directory: "/fixture" },
        body: { parts: [{ type: "text", text: "Synthetic question" }] },
      }),
    ).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
