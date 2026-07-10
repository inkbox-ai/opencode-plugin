import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { createInkboxRuntime, type InkboxRuntime, NOT_CONFIGURED_MESSAGE } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import { inkboxErrorMessage } from "../errors.js";
import { DEFAULT_OPENCODE_SERVER_URL, opencodeReachable } from "./run.js";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  message: string;
}

export interface DoctorDeps {
  runtime?: InkboxRuntime;
  opencode?: OpencodeClient;
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

  const serverUrl = config.gateway.serverUrl ?? DEFAULT_OPENCODE_SERVER_URL;
  const opencode = deps.opencode ?? createOpencodeClient({ baseUrl: serverUrl });
  if (await opencodeReachable(opencode)) {
    add("info", `opencode server reachable at ${serverUrl}.`);
  } else {
    add(
      "error",
      `opencode server unreachable at ${serverUrl}. Start it with \`opencode serve\` and set gateway.serverUrl if it listens elsewhere.`,
    );
  }

  const ok = findings.every((f) => f.severity !== "error");
  printReport(print, config, findings, serverUrl, ok);
  return { ok, findings };
}

function printReport(
  print: (line: string) => void,
  config: ResolvedConfig,
  findings: Finding[],
  serverUrl: string,
  ok: boolean,
): void {
  const g = config.gateway;
  print("Inkbox opencode gateway — doctor");
  print("");
  print("Findings:");
  for (const f of findings) print(`  [${MARK[f.severity]}] ${f.message}`);
  print("");
  print("Resolved gateway settings:");
  print(`  mode:       ${g.mode}`);
  print(`  serverUrl:  ${serverUrl}`);
  print(`  publicUrl:  ${g.publicUrl ?? `(tunnel: ${g.tunnelName ?? "auto"})`}`);
  print(`  bind:       ${g.host}:${g.port}`);
  print(`  voice:      ${g.voice.enabled ? "enabled" : "disabled"}`);
  print("");
  print(ok ? "doctor: ok" : "doctor: issues found");
}
