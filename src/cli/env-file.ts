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

// Set or replace one KEY=value line in an env file, creating the file (0600)
// and its directory when missing. The wizard persists credentials with this.
export function saveEnvVar(file: string, name: string, value: string): void {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, "utf-8").split("\n");
  } catch {
    lines = [
      "# Written by `inkbox-opencode setup`.",
      "# Loaded by the gateway; real environment variables win.",
    ];
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  // Match the same shapes loadEnvFile parses (`NAME=` with an optional
  // `export ` prefix) — a hand-written `export NAME=old` line must be
  // replaced, not shadowed, or the first-occurrence-wins load keeps it.
  const matches = (l: string) => {
    let t = l.trim();
    if (t.startsWith("export ")) t = t.slice("export ".length);
    return t.startsWith(`${name}=`);
  };
  const line = `${name}=${value}`;
  const idx = lines.findIndex(matches);
  if (idx >= 0) {
    lines[idx] = line;
    lines = lines.filter((l, i) => i === idx || !matches(l)); // drop stale duplicates
  } else {
    lines.push(line);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function parseEnvText(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
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
    if (key) pairs.push([key, value]);
  }
  return pairs;
}

// One file's vars, first occurrence winning — exactly what loadEnvFile would
// take from it. Used by doctor's shadowed-credential check.
export function readEnvFile(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of parseEnvText(text)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

// Layer every candidate that exists into `env`, in precedence order — each
// file only fills vars still missing, so an earlier file (and the real
// environment above all) wins per key. Returns the loaded paths.
// `sources`, when passed, records which file supplied each var — a var set in
// `env` but absent from the map came from the real environment.
export function loadEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  sources?: Map<string, string>,
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
    for (const [key, value] of parseEnvText(text)) {
      if (env[key] === undefined) {
        env[key] = value;
        sources?.set(key, file);
      }
    }
  }
  return loaded;
}
