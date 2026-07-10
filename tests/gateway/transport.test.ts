// The tunnel listener returned by connect() is inert until wait() drives its
// data plane — openTransport must start it and gate on "connected".
import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
vi.mock("@inkbox/sdk/tunnels/connect", () => ({
  connect: (...args: unknown[]) => connectMock(...args),
}));

import { defaultGatewayConfig } from "../../src/config.js";
import { openTransport } from "../../src/gateway/transport.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeListener(over: Record<string, unknown> = {}) {
  return {
    publicUrl: "https://name.tunnels.example",
    tunnel: { id: "tun-1" },
    wait: vi.fn(() => new Promise<void>(() => {})),
    close: vi.fn(async () => {}),
    ...over,
  };
}

function makeOpts(listener: ReturnType<typeof makeListener>) {
  connectMock.mockResolvedValue(listener);
  return {
    inkbox: { getClient: vi.fn(async () => ({})), getIdentity: vi.fn() } as never,
    gateway: { ...defaultGatewayConfig(), tunnelName: "name" },
    localUrl: "http://127.0.0.1:8767",
    ownsProcess: true,
    state: { update: vi.fn() },
    logger,
  };
}

beforeEach(() => {
  connectMock.mockReset();
});

describe("openTransport tunnel driving", () => {
  it("drives the listener with wait() and resolves once the tunnel connects", async () => {
    const listener = makeListener();
    const opts = makeOpts(listener);

    const pending = openTransport(opts);
    // connect() resolved but "connected" hasn't fired — startup must not
    // have completed yet, while the serve loop is already being driven.
    await new Promise((r) => setTimeout(r, 0));
    expect(listener.wait).toHaveBeenCalledTimes(1);

    const onStatus = (connectMock.mock.calls[0][1] as { onStatus: (s: string) => void }).onStatus;
    onStatus("connected");

    const transport = await pending;
    expect(transport.publicUrl).toBe("https://name.tunnels.example");
    expect(opts.state.update).toHaveBeenCalledWith({ tunnelId: "tun-1" });
  });

  it("fails startup and closes the listener when the serve loop dies before connecting", async () => {
    const listener = makeListener({
      wait: vi.fn(async () => {
        throw new Error("bind refused");
      }),
    });
    const opts = makeOpts(listener);

    await expect(openTransport(opts)).rejects.toThrow("bind refused");
    expect(listener.close).toHaveBeenCalled();
  });

  it("fails startup when the serve loop resolves before ever connecting", async () => {
    const listener = makeListener({ wait: vi.fn(async () => {}) });
    const opts = makeOpts(listener);

    await expect(openTransport(opts)).rejects.toThrow(/closed before reaching connected/);
    expect(listener.close).toHaveBeenCalled();
  });

  it("rejects failed when the tunnel dies after connecting", async () => {
    let settleWait: (err?: Error) => void = () => {};
    const listener = makeListener({
      wait: vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            settleWait = (err) => (err ? reject(err) : resolve());
          }),
      ),
    });
    const opts = makeOpts(listener);

    const pending = openTransport(opts);
    await new Promise((r) => setTimeout(r, 0));
    (connectMock.mock.calls[0][1] as { onStatus: (s: string) => void }).onStatus("connected");
    const transport = await pending;

    const outcome = vi.fn();
    transport.failed?.then(
      () => outcome("resolved"),
      (err: unknown) => outcome(String(err)),
    );
    settleWait(new Error("TunnelSupersededError: another client connected"));
    await new Promise((r) => setTimeout(r, 0));
    expect(outcome).toHaveBeenCalledWith(expect.stringContaining("Superseded"));
  });

  it("does not reject failed on a deliberate close", async () => {
    let settleWait: (err?: Error) => void = () => {};
    const listener = makeListener({
      wait: vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            settleWait = (err) => (err ? reject(err) : resolve());
          }),
      ),
    });
    const opts = makeOpts(listener);

    const pending = openTransport(opts);
    await new Promise((r) => setTimeout(r, 0));
    (connectMock.mock.calls[0][1] as { onStatus: (s: string) => void }).onStatus("connected");
    const transport = await pending;

    const outcome = vi.fn();
    transport.failed?.then(
      () => outcome("clean"),
      () => outcome("rejected"),
    );
    await transport.close();
    settleWait(); // the serve loop winds down as part of the close
    await new Promise((r) => setTimeout(r, 0));
    expect(outcome).toHaveBeenCalledWith("clean");
  });

  it("uses a configured publicUrl without touching the tunnel", async () => {
    const listener = makeListener();
    const opts = makeOpts(listener);
    opts.gateway = { ...opts.gateway, publicUrl: "https://static.example" };

    const transport = await openTransport(opts);
    expect(transport.publicUrl).toBe("https://static.example");
    expect(connectMock).not.toHaveBeenCalled();
  });
});
