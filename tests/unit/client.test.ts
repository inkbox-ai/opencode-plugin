import { describe, expect, it, vi } from "vitest";
import type { InkboxCredentials } from "../../src/client.js";
import { createInkboxRuntime, NOT_CONFIGURED_MESSAGE } from "../../src/client.js";

// Only the unconfigured paths are covered here: a configured runtime performs
// a whoami() round-trip against the live API on first resolve, so the happy
// path belongs to integration coverage, not unit tests.
describe("createInkboxRuntime", () => {
  it("rejects getIdentity and getClient when no credentials are configured", async () => {
    const runtime = createInkboxRuntime({});
    await expect(runtime.getIdentity()).rejects.toThrow(NOT_CONFIGURED_MESSAGE);
    await expect(runtime.getClient()).rejects.toThrow(NOT_CONFIGURED_MESSAGE);
  });

  it("requires both apiKey and identity", async () => {
    const keyOnly = createInkboxRuntime({ apiKey: "k" });
    await expect(keyOnly.getClient()).rejects.toThrow(NOT_CONFIGURED_MESSAGE);
    const identityOnly = createInkboxRuntime({ identity: "agent" });
    await expect(identityOnly.getClient()).rejects.toThrow(NOT_CONFIGURED_MESSAGE);
  });

  it("re-reads a config-source function on every resolution attempt", async () => {
    const creds: InkboxCredentials = {};
    const source = vi.fn(() => creds);
    const runtime = createInkboxRuntime(source);

    await expect(runtime.getIdentity()).rejects.toThrow(NOT_CONFIGURED_MESSAGE);
    expect(source).toHaveBeenCalledTimes(1);

    // Credentials arriving later (still incomplete here) are seen on the next
    // call because the source is consulted per resolution, not once at setup.
    creds.apiKey = "k";
    await expect(runtime.getClient()).rejects.toThrow(NOT_CONFIGURED_MESSAGE);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("explains how to configure the plugin in the error message", () => {
    expect(NOT_CONFIGURED_MESSAGE).toContain("INKBOX_API_KEY");
    expect(NOT_CONFIGURED_MESSAGE).toContain("INKBOX_IDENTITY");
    expect(NOT_CONFIGURED_MESSAGE).toContain("opencode.json");
  });
});
