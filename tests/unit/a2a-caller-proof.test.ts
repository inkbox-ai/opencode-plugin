import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("live A2A terminal answer proof", () => {
  it.each(["single", "multi"])(
    "%s rejects echoed caller tokens when the final agent answer is wrong",
    (mode) => {
      const result = execFileSync(
        "python3",
        [
          "-c",
          `
import sys, types
sys.dont_write_bytecode = True
sys.path.insert(0, "tests/live")
# These regressions run the actual protocol scenarios, without network IO.
sys.modules["inkbox"] = types.SimpleNamespace(Inkbox=object)
import a2a_driver as driver
mode = sys.argv[1]
run = "proof"
completion = f"a2a-ci-inbound-{mode}-{run}"
answer = f"a2a-ci-answer-{run}"
class Protocol:
    def __init__(self, valid):
        self.valid = valid
        self.reads = 0
    def send(self, *args, **kwargs):
        return types.SimpleNamespace(kind="task", task=types.SimpleNamespace(id="task"))
    def get_task(self, *args, **kwargs):
        self.reads += 1
        state = "TASK_STATE_INPUT_REQUIRED" if mode == "multi" and self.reads == 1 else "TASK_STATE_COMPLETED"
        return types.SimpleNamespace(id="task", context_id="context", state=state, raw={"history": [
            {"role": "ROLE_USER", "parts": [{"text": completion + " " + answer}]},
            {"role": "ROLE_AGENT", "parts": [{"text": completion + " " + answer if self.valid else "Unrelated answer"}]},
        ]})
scenario = driver._inbound_multi if mode == "multi" else driver._inbound_single
for valid in (False, True):
    rejected = False
    try:
        scenario(Protocol(valid), object(), 1, run)
    except AssertionError:
        rejected = True
    assert rejected == (not valid), (valid, rejected)
print("caller-only tokens rejected; actual final agent answer required")
`,
          mode,
        ],
        { encoding: "utf8" },
      );
      expect(result).toContain("caller-only tokens rejected");
    },
  );
});
