import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { createInkboxRuntime, type InkboxRuntime, NOT_CONFIGURED_MESSAGE } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import { inkboxErrorMessage } from "../errors.js";
import { envFileCandidates, readEnvFile } from "./env-file.js";
import { DEFAULT_OPENCODE_SERVER_URL, opencodeBinAvailable, opencodeReachable } from "./serve.js";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  message: string;
}

export interface DoctorDeps {
  runtime?: InkboxRuntime;
  opencode?: OpencodeClient;
  // Overrides the PATH lookup for the managed-serve binary check.
  opencodeBinFound?: boolean;
  // Provenance inputs for the credentials block and the shadowed-credential
  // check: the process env plus the per-var file-source map recorded by
  // loadEnvFile at CLI start.
  env?: NodeJS.ProcessEnv;
  envSources?: Map<string, string>;
  cwd?: string;
  print?: (line: string) => void;
}

const MARK: Record<Severity, string> = { error: "FAIL", warning: "WARN", info: "INFO" };

// Diagnose the sidecar: credentials, Inkbox API reachability, identity
// resolution, the gateway signing key, and whether the opencode server is up.
// Also echoes the resolved gateway settings so misconfiguration is obvious.
export async function runDoctor(
  config: ResolvedConfig,
  deps: DoctorDeps = {},
): Promise<{ ok: boolean; findings: Finding[] }> {
  const print = deps.print ?? ((line: string) => console.log(line));
  const findings: Finding[] = [];
  const add = (severity: Severity, message: string) => findings.push({ severity, message });

  if (!config.apiKey || !config.identity) {
    add("error", NOT_CONFIGURED_MESSAGE);
  }
  if (!config.signingKey) {
    add(
      "warning",
      "No signing key configured (INKBOX_SIGNING_KEY). The gateway needs it to verify inbound webhook signatures.",
    );
  }

  if (config.apiKey && config.identity) {
    const runtime =
      deps.runtime ??
      createInkboxRuntime(() => ({
        apiKey: config.apiKey,
        identity: config.identity,
        baseUrl: config.baseUrl,
      }));
    try {
      const inkbox = await runtime.getClient();
      const info = await inkbox.whoami();
      if (info.authType !== "api_key") {
        add("warning", `Authenticated as ${info.authType}; expected an api_key credential.`);
      }
    } catch (err) {
      add("error", `Inkbox API unreachable (whoami failed): ${inkboxErrorMessage(err)}`);
    }
    try {
      const id = await runtime.getIdentity();
      add(
        "info",
        `Identity "${id.agentHandle}" resolves (email: ${id.emailAddress ?? "none"}, phone: ${id.phoneNumber?.number ?? "none"}).`,
      );
    } catch (err) {
      add("error", `Identity "${config.identity}" did not resolve: ${inkboxErrorMessage(err)}`);
    }
  }

  // Stale-credential shadowing: a var that resolves from the shell (or an
  // earlier env file) while a lower-precedence file defines a DIFFERENT value
  // is the classic silently-401 setup — the wizard wrote a fresh key, but an
  // old export still wins. Only checked when the CLI hands us the source map,
  // so unit callers stay hermetic.
  if (deps.envSources) {
    for (const f of shadowFindings(
      deps.env ?? process.env,
      deps.cwd ?? process.cwd(),
      deps.envSources,
    )) {
      findings.push(f);
    }
  }

  // An explicitly configured server must answer; the default URL falling
  // through to a managed `opencode serve` only needs the binary to exist.
  const explicit = config.gateway.serverUrl;
  const serverUrl = explicit ?? DEFAULT_OPENCODE_SERVER_URL;
  const opencode = deps.opencode ?? createOpencodeClient({ baseUrl: serverUrl });
  if (await opencodeReachable(opencode)) {
    add("info", `opencode server reachable at ${serverUrl}.`);
  } else if (explicit) {
    add(
      "error",
      `opencode server unreachable at ${serverUrl}. Start it with \`opencode serve\`, or drop gateway.serverUrl / OPENCODE_SERVER_URL to let the gateway launch its own.`,
    );
  } else {
    const { bin, port } = config.gateway.serve;
    const found = deps.opencodeBinFound ?? opencodeBinAvailable(bin);
    if (found) {
      add(
        "info",
        `no opencode server at ${serverUrl}; the gateway will launch its own \`${bin} serve\` on port ${port}.`,
      );
    } else {
      add(
        "error",
        `opencode binary "${bin}" not found on PATH — install opencode (npm install -g opencode-ai) or set gateway.serverUrl.`,
      );
    }
  }

  const ok = findings.every((f) => f.severity !== "error");
  const creds = credentialLines(config, deps.env ?? process.env, deps.envSources ?? new Map());
  printReport(print, config, findings, creds, ok);
  return { ok, findings };
}

const SHADOWABLE_VARS = [
  "INKBOX_API_KEY",
  "INKBOX_IDENTITY",
  "INKBOX_SIGNING_KEY",
  "INKBOX_BASE_URL",
];

// Flag credentials whose winning source overrides a different value in a
// lower-precedence env file. The fresh value is usually the one in the file
// (the wizard writes there), so say who wins and how to get rid of it.
function shadowFindings(
  env: NodeJS.ProcessEnv,
  cwd: string,
  sources: Map<string, string>,
): Finding[] {
  const findings: Finding[] = [];
  const candidates = envFileCandidates(env, cwd);
  for (const name of SHADOWABLE_VARS) {
    const winner = env[name];
    if (winner === undefined) continue;
    const winnerFile = sources.get(name); // absent → the shell environment won
    const below = winnerFile ? candidates.indexOf(winnerFile) + 1 : 0;
    for (const file of candidates.slice(below)) {
      const value = readEnvFile(file)[name];
      if (value === undefined || value === winner) continue;
      findings.push({
        severity: "warning",
        message: winnerFile
          ? `$${name} comes from ${winnerFile}, which overrides a different value in ${file} — if Inkbox rejects a stale credential, update or remove it in ${winnerFile}.`
          : `$${name} is exported by your shell, which overrides a different value in ${file} — if Inkbox rejects a stale credential, remove the export (run \`unset ${name}\` and check ~/.zshrc).`,
      });
      break; // one finding per var is enough
    }
  }
  return findings;
}

// Name the source each resolved credential actually came from — a stale
// shell export shadowing the wizard-written env file is invisible otherwise.
function credentialLines(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv,
  sources: Map<string, string>,
): string[] {
  const from = (value: string, ...names: string[]): string => {
    for (const name of names) {
      if (env[name] === value) return sources.get(name) ?? `shell environment ($${name})`;
    }
    return "plugin options or ~/.inkbox/config";
  };
  const secret = (v: string) => `…${v.slice(-6)}`;
  return [
    config.apiKey
      ? `  api key:     ${secret(config.apiKey)}  — from ${from(config.apiKey, "INKBOX_API_KEY")}`
      : "  api key:     (not set)",
    config.identity
      ? `  identity:    ${config.identity}  — from ${from(config.identity, "INKBOX_IDENTITY", "INKBOX_AGENT_IDENTITY", "INKBOX_AGENT_HANDLE")}`
      : "  identity:    (not set)",
    config.signingKey
      ? `  signing key: ${secret(config.signingKey)}  — from ${from(config.signingKey, "INKBOX_SIGNING_KEY")}`
      : "  signing key: (not set)",
    ...(config.baseUrl
      ? [`  base url:    ${config.baseUrl}  — from ${from(config.baseUrl, "INKBOX_BASE_URL")}`]
      : []),
  ];
}

function printReport(
  print: (line: string) => void,
  config: ResolvedConfig,
  findings: Finding[],
  creds: string[],
  ok: boolean,
): void {
  const g = config.gateway;
  const serverLine =
    g.serverUrl ??
    `${DEFAULT_OPENCODE_SERVER_URL} (default; managed \`${g.serve.bin} serve\` fallback on :${g.serve.port})`;
  print("Inkbox opencode gateway — doctor");
  print("");
  print("Findings:");
  for (const f of findings) print(`  [${MARK[f.severity]}] ${f.message}`);
  print("");
  print("Credentials (resolved):");
  for (const line of creds) print(line);
  print("");
  print("Resolved gateway settings:");
  print(`  mode:       ${g.mode}`);
  print(`  serverUrl:  ${serverLine}`);
  print(`  publicUrl:  ${g.publicUrl ?? `(tunnel: ${g.tunnelName ?? "auto"})`}`);
  print(`  bind:       ${g.host}:${g.port}`);
  print(`  voice:      ${g.voice.enabled ? "enabled" : "disabled"}`);
  print("");
  print(ok ? "doctor: ok" : "doctor: issues found");
}
