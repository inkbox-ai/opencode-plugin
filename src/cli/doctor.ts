import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { createInkboxRuntime, type InkboxRuntime, NOT_CONFIGURED_MESSAGE } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import { inkboxErrorMessage } from "../errors.js";
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
  printReport(print, config, findings, ok);
  return { ok, findings };
}

function printReport(
  print: (line: string) => void,
  config: ResolvedConfig,
  findings: Finding[],
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
  print("Resolved gateway settings:");
  print(`  mode:       ${g.mode}`);
  print(`  serverUrl:  ${serverLine}`);
  print(`  publicUrl:  ${g.publicUrl ?? `(tunnel: ${g.tunnelName ?? "auto"})`}`);
  print(`  bind:       ${g.host}:${g.port}`);
  print(`  voice:      ${g.voice.enabled ? "enabled" : "disabled"}`);
  print("");
  print(ok ? "doctor: ok" : "doctor: issues found");
}
