import { describe, expect, it } from "vitest";
import { requireExactCallPair } from "../live/call-pairing.js";

const started = Date.parse("2026-08-01T00:00:00Z");
const call = (id: string, offset = 1_000) => ({
  id,
  direction: "inbound",
  remotePhoneNumber: "+14155550123",
  createdAt: new Date(started + offset),
});

describe("live call ownership pairing", () => {
  it("accepts exactly one current driver/AUT pair", () => {
    expect(
      requireExactCallPair([call("driver")], [call("aut", 2_000)], {
        scenarioStartedAt: started,
        maxCreationSkewMs: 5_000,
      }),
    ).toMatchObject({ driver: { id: "driver" }, aut: { id: "aut" } });
  });

  it("rejects duplicate driver or AUT legs with identifying diagnostics", () => {
    let diagnostic = "";
    try {
      requireExactCallPair([call("driver-1"), call("driver-2")], [call("aut")], {
        scenarioStartedAt: started,
        maxCreationSkewMs: 5_000,
      });
    } catch (error) {
      diagnostic = String(error);
    }
    expect(diagnostic).toMatch(/driver-1.*driver-2.*aut/);
    expect(diagnostic).not.toContain("14155550123");
    expect(() =>
      requireExactCallPair([call("driver")], [call("aut-1"), call("aut-2")], {
        scenarioStartedAt: started,
        maxCreationSkewMs: 5_000,
      }),
    ).toThrow(/driver.*aut-1.*aut-2/);
  });

  it("rejects stale and creation-skewed pairs", () => {
    expect(() =>
      requireExactCallPair([call("driver", -1)], [call("aut")], {
        scenarioStartedAt: started,
        maxCreationSkewMs: 5_000,
      }),
    ).toThrow("do not belong to this scenario");
    expect(() =>
      requireExactCallPair([call("driver", 1_000)], [call("aut", 20_000)], {
        scenarioStartedAt: started,
        maxCreationSkewMs: 5_000,
      }),
    ).toThrow("do not belong to this scenario");
  });
});
