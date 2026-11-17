import { readFileSync } from "node:fs";

const requested = process.argv[2] ?? "latest";
const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const supported = engines.opencode
  .split("||")
  .map((range) => range.trim())
  .find((range) => range.startsWith(">=2."));
if (!supported) throw new Error("The package does not declare a supported OpenCode V2 range.");
if (requested !== "latest" && !/^2\.\d+\.\d+$/.test(requested))
  throw new Error("Specify latest or an explicit OpenCode V2 release.");
console.log(`@opencode/cli@${requested === "latest" ? supported : requested}`);
