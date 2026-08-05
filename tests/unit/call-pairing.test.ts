import { describe, expect, it } from "vitest";
import { agentLegForPair, requireExactCallPair } from "../live/call-pairing.js";

const started = Date.parse("2026-08-01T00:00:00Z");
const call = (id: string, offset = 1_000) => ({
  id,
  direction: "inbound",
  remotePhoneNumber: "+14155550123",
  createdAt: new Date(started + offset),
});

describe("live call ownership pairing", () => {
  it("queries the paired call through the AUT client", async () => {
    const seen: unknown[] = [];
    const autLeg = { ...call("aut"), direction: "outbound" };
    const aut = {
      calls: {
        async list(options: unknown) {
          seen.push(options);
          return [autLeg];
        },
      },
    };

    await expect(
      agentLegForPair(
        { ...call("driver"), pairedCallId: "33333333-3333-3333-3333-333333333333" },
        aut,
        [],
        { direction: "outbound", scenarioStartedAt: started, maxCreationSkewMs: 5_000 },
      ),
    ).resolves.toBe(autLeg);
    expect(seen).toEqual([{ limit: 2, pairedCallId: "33333333-3333-3333-3333-333333333333" }]);
  });

  it("keeps strict correlation while the additive pair filter rolls out", async () => {
    const driver = call("driver");
    const autLeg = call("aut", 2_000);
    const aut = { calls: { list: async () => [] } };

    await expect(
      agentLegForPair(driver, aut, [autLeg], {
        direction: "inbound",
        scenarioStartedAt: started,
        maxCreationSkewMs: 5_000,
      }),
    ).resolves.toBe(autLeg);
  });

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
