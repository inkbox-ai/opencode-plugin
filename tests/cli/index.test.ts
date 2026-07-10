import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  daemonStatus,
  restartDaemon,
  runUninstall,
  startDaemon,
  stopDaemon,
} from "../../src/cli/daemon.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { runCli } from "../../src/cli/index.js";
import { runForeground, runWhoami } from "../../src/cli/run.js";
import { runSetup } from "../../src/cli/setup.js";

// Config resolution is stubbed so dispatch tests never touch the real
// environment or ~/.inkbox/config; the command impls ignore the value.
vi.mock("../../src/config.js", () => ({
  resolveConfig: vi.fn(() => ({ gateway: {} })),
}));

vi.mock("../../src/cli/run.js", () => ({
  runForeground: vi.fn(async () => 0),
  runWhoami: vi.fn(async () => 0),
}));

vi.mock("../../src/cli/daemon.js", () => ({
  startDaemon: vi.fn(async () => 0),
  stopDaemon: vi.fn(async () => 0),
  restartDaemon: vi.fn(async () => 0),
  daemonStatus: vi.fn(async () => 0),
  runUninstall: vi.fn(async () => 0),
}));

vi.mock("../../src/cli/doctor.js", () => ({
  runDoctor: vi.fn(async () => ({ ok: true, findings: [] })),
}));

vi.mock("../../src/cli/setup.js", () => ({
  runSetup: vi.fn(() => 0),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runCli dispatch", () => {
  it("routes `run` to the foreground gateway", async () => {
    const code = await runCli(["run"]);
    expect(runForeground).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });

  it("routes daemon lifecycle commands to their impls", async () => {
    await runCli(["start"]);
    await runCli(["stop"]);
    await runCli(["restart"]);
    await runCli(["status"]);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(restartDaemon).toHaveBeenCalledTimes(1);
    expect(daemonStatus).toHaveBeenCalledTimes(1);
  });

  it("routes `whoami`, `setup`, and `uninstall`", async () => {
    await runCli(["whoami"]);
    await runCli(["setup"]);
    await runCli(["uninstall"]);
    expect(runWhoami).toHaveBeenCalledTimes(1);
    expect(runSetup).toHaveBeenCalledTimes(1);
    expect(runUninstall).toHaveBeenCalledTimes(1);
  });

  it("returns 0 when doctor reports ok and 1 when it finds errors", async () => {
    expect(await runCli(["doctor"])).toBe(0);
    vi.mocked(runDoctor).mockResolvedValueOnce({
      ok: false,
      findings: [{ severity: "error", message: "boom" }],
    });
    expect(await runCli(["doctor"])).toBe(1);
  });

  it("prints usage and returns 0 for --help and no command", async () => {
    expect(await runCli(["--help"])).toBe(0);
    expect(await runCli([])).toBe(0);
    expect(runForeground).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
  });

  it("returns a non-zero code for an unknown command", async () => {
    const code = await runCli(["frobnicate"]);
    expect(code).toBe(2);
    expect(console.error).toHaveBeenCalled();
  });
});
