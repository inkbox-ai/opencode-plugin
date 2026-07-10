import { VERSION as SDK_VERSION } from "@inkbox/sdk";
import { NOT_CONFIGURED_MESSAGE } from "../client.js";
import { inkboxErrorMessage } from "../errors.js";
import { formatWithHeader } from "../format.js";
import type { GatingSummary } from "./registry.js";
import { describeGating } from "./registry.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

interface Finding {
  severity: "error" | "warning" | "info";
  message: string;
}

// Diagnostics tool. Deliberately cheap and side-effect free: config presence,
// one whoami() round-trip, one identity fetch, vault key presence (never the
// value), and the tool-gating summary so the model can report what exists
// but is switched off.
export function doctorTools(deps: ToolDeps, getGating: () => GatingSummary): RegisteredTool[] {
  return [
    {
      name: "inkbox_doctor",
      group: "diagnostics",
      defaultEnabled: true,
      definition: {
        description:
          "Run Inkbox plugin diagnostics: config presence, API reachability, key scope, identity resolution, vault key presence, and which tool groups are enabled or disabled. Use when Inkbox tools fail or to check what capabilities are available.",
        args: {},
        async execute() {
          const { config, runtime } = deps;
          const findings: Finding[] = [];
          const report: Record<string, unknown> = {
            sdkVersion: SDK_VERSION,
            baseUrl: config.baseUrl ?? "https://inkbox.ai (default)",
          };

          if (!config.apiKey || !config.identity) {
            findings.push({ severity: "error", message: NOT_CONFIGURED_MESSAGE });
          }
          if (!config.signingKey) {
            findings.push({
              severity: "warning",
              message:
                "No signing key configured (INKBOX_SIGNING_KEY). Not needed for outbound tools; required later for inbound webhook verification.",
            });
          }
          if (!process.env[deps.vault.keyEnvVar]) {
            findings.push({
              severity: "info",
              message: `Vault unlock key not present (${deps.vault.keyEnvVar}). Vault tools, if enabled, will report the vault as locked.`,
            });
          }

          if (config.apiKey && config.identity) {
            try {
              const inkbox = await runtime.getClient();
              const info = await inkbox.whoami();
              report.whoami = info;
              if (info.authType !== "api_key") {
                findings.push({
                  severity: "warning",
                  message: `Authenticated as ${info.authType}; expected an api_key credential.`,
                });
              }
            } catch (err) {
              findings.push({
                severity: "error",
                message: `whoami() failed: ${inkboxErrorMessage(err)}`,
              });
            }
            try {
              const identity = await runtime.getIdentity();
              report.identity = {
                agentHandle: identity.agentHandle,
                displayName: identity.displayName,
                emailAddress: identity.emailAddress,
                dedicatedNumber: identity.phoneNumber?.number ?? null,
                imessageEnabled: Boolean((identity as any).imessageEnabled),
              };
            } catch (err) {
              findings.push({
                severity: "error",
                message: `Identity "${config.identity}" did not resolve: ${inkboxErrorMessage(err)}`,
              });
            }
          }

          const gating = getGating();
          report.tools = {
            enabled: gating.enabled,
            gating: describeGating(gating),
          };
          report.findings = findings;
          const ok = findings.every((f) => f.severity !== "error");
          return {
            title: ok ? "Inkbox doctor: ok" : "Inkbox doctor: issues found",
            output: formatWithHeader(
              ok
                ? "Inkbox doctor: everything looks good."
                : "Inkbox doctor: issues found — see findings.",
              report,
            ),
          };
        },
      },
    },
  ];
}
