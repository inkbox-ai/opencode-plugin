import type { ToolDefinition } from "@opencode-ai/plugin";
import { a2aTools } from "./a2a.js";
import { accessTools } from "./access.js";
import { callReadTools } from "./call-reads.js";
import { contactRuleTools } from "./contact-rules.js";
import { contactTools } from "./contacts.js";
import { doctorTools } from "./doctor.js";
import { emailReadTools } from "./email-reads.js";
import { forwardEmailTools } from "./forward-email.js";
import { imessageReadTools } from "./imessage-reads.js";
import { noteTools } from "./notes.js";
import { placeCallTools } from "./place-call.js";
import type { GatingSummary } from "./registry.js";
import { selectTools } from "./registry.js";
import { sendEmailTools } from "./send-email.js";
import { sendIMessageTools } from "./send-imessage.js";
import { sendSmsTools } from "./send-sms.js";
import { smsReadTools } from "./sms-reads.js";
import type { RegisteredTool, ToolDeps } from "./types.js";
import { vaultTools } from "./vault.js";
import { whoamiTools } from "./whoami.js";

const EMPTY_GATING: GatingSummary = { enabled: [], disabledByDefault: [], groups: [] };

function buildGroups(deps: ToolDeps, getGating: () => GatingSummary): RegisteredTool[] {
  return [
    ...a2aTools(deps),
    ...sendEmailTools(deps),
    ...forwardEmailTools(deps),
    ...emailReadTools(deps),
    ...sendSmsTools(deps),
    ...smsReadTools(deps),
    ...sendIMessageTools(deps),
    ...imessageReadTools(deps),
    ...placeCallTools(deps),
    ...callReadTools(deps),
    ...contactTools(deps),
    ...noteTools(deps),
    ...contactRuleTools(deps),
    ...accessTools(deps),
    ...vaultTools(deps),
    ...whoamiTools(deps),
    ...doctorTools(deps, getGating),
  ];
}

// The complete catalog, gating ignored. Used by tests and docs generation.
export function buildAllTools(deps: ToolDeps): RegisteredTool[] {
  return buildGroups(deps, () => EMPTY_GATING);
}

export function registerTools(deps: ToolDeps): {
  tools: Record<string, ToolDefinition>;
  summary: GatingSummary;
} {
  // Doctor reads the gating summary lazily — it is computed below, once the
  // full tool list (doctor included) has gone through selection.
  let gating = EMPTY_GATING;
  const all = buildGroups(deps, () => gating);
  const result = selectTools(all, deps.config.tools);
  gating = result.summary;
  return result;
}
