// Contract with the opencode plugin API. These assertions pin the host
// surface this plugin depends on; CI runs them against @opencode-ai/plugin
// `latest` to catch upstream drift before users do.

import type {
  Hooks,
  Plugin,
  PluginInput,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("@opencode-ai/plugin host interface", () => {
  it("exports the tool() helper with a zod schema namespace", () => {
    expect(typeof tool).toBe("function");
    expect(typeof tool.schema).toBe("object");
    expect(typeof tool.schema.object).toBe("function");
    expect(typeof tool.schema.string).toBe("function");
  });

  it("tool() accepts { description, args, execute } and returns it", () => {
    const def = tool({
      description: "probe",
      args: { value: tool.schema.string() },
      async execute(args) {
        return `got ${args.value}`;
      },
    });
    expect(def.description).toBe("probe");
    expect(def.args).toHaveProperty("value");
    expect(typeof def.execute).toBe("function");
  });

  it("ToolDefinition literals type-check without the tool() helper", () => {
    // The plugin builds definitions as plain literals; this pins that the
    // structural shape stays assignable.
    const def: ToolDefinition = {
      description: "probe",
      args: {},
      async execute() {
        return "ok";
      },
    };
    expect(def).toBeDefined();
  });

  it("ToolContext exposes the fields tools rely on", () => {
    expectTypeOf<ToolContext>().toHaveProperty("sessionID").toBeString();
    expectTypeOf<ToolContext>().toHaveProperty("abort").toEqualTypeOf<AbortSignal>();
    expectTypeOf<ToolContext["ask"]>().toBeFunction();
    expectTypeOf<ToolContext["ask"]>().returns.resolves.toBeVoid();
    expectTypeOf<ToolContext["metadata"]>().toBeFunction();
  });

  it("ToolResult accepts a string or a { title, output } object", () => {
    expectTypeOf<string>().toMatchTypeOf<ToolResult>();
    expectTypeOf<{ title: string; output: string }>().toMatchTypeOf<ToolResult>();
  });

  it("Plugin is (input, options?) => Promise<Hooks> and Hooks carries a tool map", () => {
    expectTypeOf<Plugin>().parameter(0).toEqualTypeOf<PluginInput>();
    expectTypeOf<Plugin>().returns.resolves.toEqualTypeOf<Hooks>();
    expectTypeOf<Hooks>().toHaveProperty("tool");
    expectTypeOf<NonNullable<Hooks["tool"]>>().toEqualTypeOf<{
      [key: string]: ToolDefinition;
    }>();
  });

  it("PluginInput exposes the opencode server client and Bun shell", () => {
    expectTypeOf<PluginInput>().toHaveProperty("client");
    expectTypeOf<PluginInput>().toHaveProperty("directory").toBeString();
    expectTypeOf<PluginInput>().toHaveProperty("worktree").toBeString();
    expectTypeOf<PluginInput>().toHaveProperty("$");
  });
});
