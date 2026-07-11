import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envFileCandidates, loadEnvFile, saveEnvVar } from "../../src/cli/env-file.js";

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-envfile-cwd-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "inkbox-envfile-home-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// Every test drives gatewayHome() through the env override so nothing touches
// the real ~/.inkbox-opencode.
function makeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { INKBOX_OPENCODE_HOME: home, ...extra };
}

describe("envFileCandidates", () => {
  it("orders explicit file, ./.env, then the state-dir .env", () => {
    const env = makeEnv({ INKBOX_OPENCODE_ENV_FILE: "/etc/custom.env" });
    expect(envFileCandidates(env, cwd)).toEqual([
      "/etc/custom.env",
      path.join(cwd, ".env"),
      path.join(home, ".env"),
    ]);
  });

  it("omits the explicit entry when the env var is unset", () => {
    expect(envFileCandidates(makeEnv(), cwd)).toEqual([
      path.join(cwd, ".env"),
      path.join(home, ".env"),
    ]);
  });
});

describe("loadEnvFile", () => {
  it("returns an empty list when no candidate exists", () => {
    const env = makeEnv();
    expect(loadEnvFile(env, cwd)).toEqual([]);
  });

  it("loads ./.env, skipping comments and stripping export/quotes", () => {
    fs.writeFileSync(
      path.join(cwd, ".env"),
      [
        "# comment",
        "",
        "INKBOX_API_KEY=abc",
        'export INKBOX_IDENTITY="agent"',
        "INKBOX_BASE_URL='https://x.example'",
        "not a kv line",
      ].join("\n"),
    );
    const env = makeEnv();
    expect(loadEnvFile(env, cwd)).toEqual([path.join(cwd, ".env")]);
    expect(env.INKBOX_API_KEY).toBe("abc");
    expect(env.INKBOX_IDENTITY).toBe("agent");
    expect(env.INKBOX_BASE_URL).toBe("https://x.example");
  });

  it("never overrides vars already present in the environment", () => {
    fs.writeFileSync(path.join(cwd, ".env"), "INKBOX_API_KEY=from-file\nINKBOX_IDENTITY=bob\n");
    const env = makeEnv({ INKBOX_API_KEY: "from-shell" });
    loadEnvFile(env, cwd);
    expect(env.INKBOX_API_KEY).toBe("from-shell");
    expect(env.INKBOX_IDENTITY).toBe("bob");
  });

  it("layers all candidates: earlier files win per key, later ones fill gaps", () => {
    const explicit = path.join(home, "boot.env");
    fs.writeFileSync(explicit, "INKBOX_IDENTITY=explicit\n");
    fs.writeFileSync(path.join(cwd, ".env"), "INKBOX_IDENTITY=cwd\nINKBOX_API_KEY=from-cwd\n");
    fs.writeFileSync(path.join(home, ".env"), "INKBOX_BASE_URL=https://state.example\n");
    const env = makeEnv({ INKBOX_OPENCODE_ENV_FILE: explicit });
    expect(loadEnvFile(env, cwd)).toEqual([
      explicit,
      path.join(cwd, ".env"),
      path.join(home, ".env"),
    ]);
    expect(env.INKBOX_IDENTITY).toBe("explicit"); // explicit beats ./.env
    expect(env.INKBOX_API_KEY).toBe("from-cwd"); // ./.env fills the gap
    expect(env.INKBOX_BASE_URL).toBe("https://state.example"); // state dir fills the rest
  });

  it("falls back to the state-dir .env when ./.env is absent", () => {
    fs.writeFileSync(path.join(home, ".env"), "INKBOX_IDENTITY=state\n");
    const env = makeEnv();
    expect(loadEnvFile(env, cwd)).toEqual([path.join(home, ".env")]);
    expect(env.INKBOX_IDENTITY).toBe("state");
  });

  it("records which file supplied each var, and nothing for shell-env vars", () => {
    fs.writeFileSync(path.join(cwd, ".env"), "INKBOX_API_KEY=from-file\nINKBOX_IDENTITY=bob\n");
    const env = makeEnv({ INKBOX_API_KEY: "from-shell" });
    const sources = new Map<string, string>();
    loadEnvFile(env, cwd, sources);
    expect(sources.get("INKBOX_IDENTITY")).toBe(path.join(cwd, ".env"));
    expect(sources.has("INKBOX_API_KEY")).toBe(false); // shell won; no file source
  });
});

describe("saveEnvVar", () => {
  it("replaces a hand-written `export NAME=` line instead of shadowing it", () => {
    const file = path.join(home, ".env");
    fs.writeFileSync(file, "export INKBOX_API_KEY=old\nINKBOX_IDENTITY=bob\n");
    saveEnvVar(file, "INKBOX_API_KEY", "new");
    const env = makeEnv();
    loadEnvFile(env, cwd);
    expect(env.INKBOX_API_KEY).toBe("new"); // first-occurrence-wins load must see the new value
    expect(env.INKBOX_IDENTITY).toBe("bob");
  });

  it("collapses duplicate lines for the same var down to the saved value", () => {
    const file = path.join(home, ".env");
    fs.writeFileSync(file, "export INKBOX_API_KEY=older\nINKBOX_API_KEY=old\n");
    saveEnvVar(file, "INKBOX_API_KEY", "new");
    const text = fs.readFileSync(file, "utf-8");
    expect(text.match(/INKBOX_API_KEY/g)).toHaveLength(1);
    expect(text).toContain("INKBOX_API_KEY=new");
  });
});
