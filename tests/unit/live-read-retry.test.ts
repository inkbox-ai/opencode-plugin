import { describe, expect, it, vi } from "vitest";
import { retrySafeRead } from "../live/helpers.js";

describe("live idempotent read retry", () => {
  it("retries bounded read failures and returns the successful result", async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue("ready");

    await expect(retrySafeRead(read, { attempts: 3, delayMs: 0 })).resolves.toBe("ready");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not continue after the bounded attempts", async () => {
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("temporary"));

    await expect(retrySafeRead(read, { attempts: 2, delayMs: 0 })).rejects.toThrow(
      "idempotent live API read failed after 2 attempts",
    );
    expect(read).toHaveBeenCalledTimes(2);
  });
});
