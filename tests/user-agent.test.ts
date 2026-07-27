// The plugin identifies itself and its version in the SDK User-Agent.
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { pluginUserAgent } from "../src/client.js";

describe("plugin user agent", () => {
  it("names the plugin and its package version", () => {
    expect(pluginUserAgent()).toBe(`inkbox-opencode/${pkg.version}`);
  });

  it("is stable across calls", () => {
    expect(pluginUserAgent()).toBe(pluginUserAgent());
  });
});
