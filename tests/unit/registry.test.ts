import { describe, expect, it } from "vitest";
import { describeGating, isToolEnabled, selectTools } from "../../src/tools/registry.js";
import type { RegisteredTool } from "../../src/tools/types.js";

function makeTool(overrides: Partial<RegisteredTool> & { name: string }): RegisteredTool {
  return {
    group: "email",
    defaultEnabled: true,
    definition: {
      description: `stub for ${overrides.name}`,
      args: {},
      execute: async () => "",
    } as any,
    ...overrides,
  };
}

function enabled(tool: RegisteredTool, enable: string[] = [], disable: string[] = []): boolean {
  return isToolEnabled(tool, new Set(enable), new Set(disable));
}

describe("isToolEnabled", () => {
  it("follows defaultEnabled when no rule matches", () => {
    expect(enabled(makeTool({ name: "inkbox_a", defaultEnabled: true }))).toBe(true);
    expect(enabled(makeTool({ name: "inkbox_b", defaultEnabled: false }))).toBe(false);
    // Rules about other tools and groups have no effect.
    const tool = makeTool({ name: "inkbox_a", group: "email", defaultEnabled: true });
    expect(enabled(tool, ["inkbox_other"], ["sms"])).toBe(true);
  });

  it("lets an exact-name rule beat a group rule", () => {
    const tool = makeTool({ name: "inkbox_a", group: "email" });
    expect(enabled(tool, ["email"], ["inkbox_a"])).toBe(false);
    expect(enabled(tool, ["inkbox_a"], ["email"])).toBe(true);
  });

  it('lets a group rule beat an "all" rule', () => {
    const tool = makeTool({ name: "inkbox_a", group: "email" });
    expect(enabled(tool, ["email"], ["all"])).toBe(true);
    expect(enabled(tool, ["all"], ["email"])).toBe(false);
  });

  it("lets disable win over enable at the same specificity", () => {
    const tool = makeTool({ name: "inkbox_a", group: "email", defaultEnabled: true });
    expect(enabled(tool, ["inkbox_a"], ["inkbox_a"])).toBe(false);
    expect(enabled(tool, ["email"], ["email"])).toBe(false);
    expect(enabled(tool, ["all"], ["all"])).toBe(false);
  });

  it('toggles default state with "all"', () => {
    expect(enabled(makeTool({ name: "inkbox_off", defaultEnabled: false }), ["all"])).toBe(true);
    expect(enabled(makeTool({ name: "inkbox_on", defaultEnabled: true }), [], ["all"])).toBe(false);
  });

  describe("sensitive tools", () => {
    const sensitive = makeTool({
      name: "inkbox_credentials_get_login",
      group: "vault",
      defaultEnabled: false,
      sensitive: true,
    });

    it('cannot be enabled via their group or "all"', () => {
      expect(enabled(sensitive, ["vault"])).toBe(false);
      expect(enabled(sensitive, ["all"])).toBe(false);
      expect(enabled(sensitive, ["vault", "all"])).toBe(false);
    });

    it("can be enabled by exact name only", () => {
      expect(enabled(sensitive, ["inkbox_credentials_get_login"])).toBe(true);
    });

    it("still honors an exact-name disable", () => {
      expect(
        enabled(sensitive, ["inkbox_credentials_get_login"], ["inkbox_credentials_get_login"]),
      ).toBe(false);
    });

    it("keeps name precedence over group even when the group is disabled", () => {
      expect(enabled(sensitive, ["inkbox_credentials_get_login"], ["vault"])).toBe(true);
    });

    it("stays off under a group disable with no name enable", () => {
      expect(enabled(sensitive, [], ["vault"])).toBe(false);
    });
  });
});

describe("selectTools", () => {
  const all: RegisteredTool[] = [
    makeTool({ name: "inkbox_send_email", group: "email", defaultEnabled: true }),
    makeTool({ name: "inkbox_search_email", group: "email", defaultEnabled: false }),
    makeTool({ name: "inkbox_send_sms", group: "sms", defaultEnabled: true }),
    makeTool({
      name: "inkbox_credentials_get_login",
      group: "vault",
      defaultEnabled: false,
      sensitive: true,
    }),
  ];

  it("returns the enabled tool definitions keyed by name plus a gating summary", () => {
    const { tools, summary } = selectTools(all, {
      enable: ["inkbox_search_email"],
      disable: ["sms"],
    });
    expect(Object.keys(tools).sort()).toEqual(["inkbox_search_email", "inkbox_send_email"]);
    expect(tools.inkbox_send_email).toBe(all[0].definition);
    expect(summary.enabled.sort()).toEqual(["inkbox_search_email", "inkbox_send_email"]);
    expect(summary.disabledByDefault).toEqual([
      { name: "inkbox_send_sms", group: "sms", sensitive: false },
      { name: "inkbox_credentials_get_login", group: "vault", sensitive: true },
    ]);
    expect(summary.groups).toEqual(["email", "sms", "vault"]);
  });

  it("reports no disabled tools when everything is switched on by name", () => {
    const { tools, summary } = selectTools(all, {
      enable: all.map((t) => t.name),
      disable: [],
    });
    expect(Object.keys(tools)).toHaveLength(all.length);
    expect(summary.disabledByDefault).toEqual([]);
  });
});

describe("describeGating", () => {
  it("says everything is enabled when nothing is disabled", () => {
    const text = describeGating({
      enabled: ["inkbox_send_email"],
      disabledByDefault: [],
      groups: ["email"],
    });
    expect(text).toBe("All tools are enabled.");
  });

  it("lists disabled tools per group and how to enable them", () => {
    const text = describeGating({
      enabled: ["inkbox_send_email"],
      groups: ["email", "vault"],
      disabledByDefault: [
        { name: "inkbox_search_email", group: "email", sensitive: false },
        { name: "inkbox_credentials_list", group: "vault", sensitive: false },
        { name: "inkbox_credentials_get_login", group: "vault", sensitive: true },
      ],
    });
    expect(text).toContain("Disabled tools");
    expect(text).toContain("tools.enable");
    expect(text).toContain('- email: inkbox_search_email (enable by name or with "email")');
    expect(text).toContain('- vault: inkbox_credentials_list (enable by name or with "vault")');
    expect(text).toContain(
      "- vault (sensitive, exact name required): inkbox_credentials_get_login",
    );
  });
});
