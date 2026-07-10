import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayHome } from "../gateway/state.js";

// Env-file loading for the daemon: fill missing vars from a file so the boot
// service "just works" without a login shell. Real environment always wins.

// Candidate files, in precedence order: an explicit INKBOX_OPENCODE_ENV_FILE,
// ./.env, then ~/.inkbox-opencode/.env (written by `autostart install`).
export function envFileCandidates(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string[] {
  const candidates: string[] = [];
  const explicit = env.INKBOX_OPENCODE_ENV_FILE?.trim();
  if (explicit) candidates.push(explicit);
  candidates.push(path.join(cwd, ".env"));
  candidates.push(path.join(gatewayHome(env), ".env"));
  return candidates;
}

// Layer every candidate that exists into `env`, in precedence order — each
// file only fills vars still missing, so an earlier file (and the real
// environment above all) wins per key. Returns the loaded paths.
export function loadEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string[] {
  const loaded: string[] = [];
  for (const file of envFileCandidates(env, cwd)) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    loaded.push(file);
    for (const raw of text.split("\n")) {
      let line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      if (line.startsWith("export ")) line = line.slice("export ".length);
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^['"]+|['"]+$/g, "");
      if (key && env[key] === undefined) env[key] = value;
    }
  }
  return loaded;
}
