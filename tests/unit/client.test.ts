import { describe, expect, it, vi } from "vitest";
import type { InkboxCredentials } from "../../src/client.js";
import {
  createInkboxRuntime,
  NOT_CONFIGURED_MESSAGE,
  resolveIdentityWithRetry,
} from "../../src/client.js";

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

  it("retries a transient identity connection reset", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const resolveIdentity = vi
      .fn<() => Promise<{ id: string }>>()
      .mockRejectedValueOnce(reset)
      .mockResolvedValue({ id: "identity-1" });
    const wait = vi.fn(async () => undefined);

    await expect(resolveIdentityWithRetry(resolveIdentity, wait)).resolves.toEqual({
      id: "identity-1",
    });
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
  });

  it("does not retry a terminal identity response", async () => {
    const notFound = Object.assign(new Error("Identity not found"), { status: 404 });
    const resolveIdentity = vi.fn<() => Promise<never>>().mockRejectedValue(notFound);
    const wait = vi.fn(async () => undefined);

    await expect(resolveIdentityWithRetry(resolveIdentity, wait)).rejects.toBe(notFound);
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("bounds repeated transient identity retries", async () => {
    const reset = new Error("Request failed: socket hang up");
    const resolveIdentity = vi.fn<() => Promise<never>>().mockRejectedValue(reset);
    const wait = vi.fn(async () => undefined);

    await expect(resolveIdentityWithRetry(resolveIdentity, wait)).rejects.toBe(reset);
    expect(resolveIdentity).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[250], [750]]);
  });
});
