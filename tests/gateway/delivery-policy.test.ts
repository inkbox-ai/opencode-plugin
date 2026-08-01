import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyDeliveryFailure,
  deliveryFailureKey,
  deliveryFailureRecovery,
  resetDeliveryPolicyForTest,
} from "../../src/gateway/delivery-policy.js";

beforeEach(resetDeliveryPolicyForTest);

describe("delivery failure retry policy", () => {
  it("requires correction only when the failure is both first and retryable", () => {
    const first = deliveryFailureRecovery({
      key: "sms:target:1",
      channel: "sms",
      target: "+1",
      failure: "content policy: markdown",
      failedBody: "**hello**",
    });
    expect(first).toMatchObject({ attempt: 1, classification: "retryable", mandatory: true });
    expect(first.prompt).toContain("MUST send exactly one");
    expect(first.prompt).toContain("Do not return [SILENT]");

    const second = deliveryFailureRecovery({
      key: "sms:target:1",
      channel: "sms",
      target: "+1",
      failure: "content policy: markdown",
    });
    expect(second).toMatchObject({ attempt: 2, classification: "retryable", mandatory: false });
    expect(second.prompt).toContain("reply exactly [SILENT]");
  });

  it("never mandates a terminal or ambiguous first failure", () => {
    const terminal = deliveryFailureRecovery({
      key: "sms:target:2",
      channel: "sms",
      failure: "recipient opted out",
    });
    const unknown = deliveryFailureRecovery({
      key: "sms:target:3",
      channel: "sms",
      failure: "connection closed after request",
    });
    expect(terminal.mandatory).toBe(false);
    expect(terminal.prompt).toContain("Do not retry");
    expect(unknown.mandatory).toBe(false);
    expect(unknown.prompt).toContain("unlikely to duplicate");
  });

  it("caps the loop after three failed sends", () => {
    for (let i = 0; i < 2; i++) {
      expect(
        deliveryFailureRecovery({ key: "k", channel: "sms", failure: "spam" }).prompt,
      ).toBeDefined();
    }
    expect(
      deliveryFailureRecovery({ key: "k", channel: "sms", failure: "spam" }).prompt,
    ).toBeUndefined();
  });

  it("lets terminal safety signals win over broad content markers", () => {
    expect(classifyDeliveryFailure("unsafe content blocked")).toBe("terminal");
  });

  it("does not blindly retry an ambiguous server error that only mentions Content-Type", () => {
    const result = deliveryFailureRecovery({
      key: "sms:target:4",
      channel: "sms",
      target: "+14155550123",
      failure: "HTTP 500 while parsing Content-Type",
    });
    expect(result).toMatchObject({ classification: "unknown", mandatory: false });
  });

  it("keeps a stable fallback key when a malformed phone target has no digits", () => {
    expect(deliveryFailureKey("sms", "unknown-target")).toBe("sms:target:unknown-target");
  });
});
