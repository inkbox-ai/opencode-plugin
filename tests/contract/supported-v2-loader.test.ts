import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("selects the declared V2 range for latest and retains the minimum host lane", () => {
  expect(
    execFileSync(process.execPath, ["scripts/opencode-v2-package.mjs", "latest"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("@opencode/cli@>=2.0.26 <2.1.0");
  expect(
    execFileSync(process.execPath, ["scripts/opencode-v2-package.mjs", "2.0.26"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("@opencode/cli@2.0.26");
  for (const file of [".github/workflows/tests.yml", ".github/workflows/canary.yml"]) {
    const workflow = readFileSync(file, "utf8");
    expect(workflow).toContain("scripts/opencode-v2-package.mjs");
    expect(workflow).not.toContain("install -g @opencode/cli@latest");
  }
});
