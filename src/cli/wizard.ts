import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_REALTIME_MODEL, type ResolvedConfig } from "../config.js";
import { gatewayHome } from "../gateway/state.js";
import { CALL_MEDIA_WS_PATH, WEBHOOK_PATH } from "../gateway/subscriptions.js";
import type { PhoneVoiceStack } from "../voice-stack.js";
import { installAutostart } from "./autostart.js";
import { restartDaemon, runningDaemonPid, startDaemon } from "./daemon.js";
import { saveEnvVar } from "./env-file.js";
import { type RealtimeValidationResult, validateOpenAIRealtime } from "./realtime-validation.js";

// Interactive setup wizard, ported from the claude-code/codex bridges:
// self-signup (or bring a key), iMessage, a dedicated number, the START
// opt-in wait, Realtime validation, the signing key, project dir, autostart.

const DEFAULT_BASE_URL = "https://inkbox.ai";
// startDaemon reports success the moment it has spawned, so a gateway that
// dies on a bad bind still leaves a pid and a success line behind. Re-check
// across a short window before telling the operator it is up.
const START_CONFIRM_TIMEOUT_MS = 5_000;
const START_CONFIRM_POLL_MS = 500;

export interface WizardIO {
  print(line?: string): void;
  ask(question: string, opts?: { def?: string; password?: boolean }): Promise<string>;
  confirm(question: string, def: boolean): Promise<boolean>;
  choose(question: string, options: string[], def: number): Promise<number>;
}

// The identity/client surface the wizard touches, typed loosely: the SDK's
// concrete types stay out of the seam so tests can fake it with plain objects.
export interface WizardSdk {
  signup(req: {
    humanEmail: string;
    noteToHuman: string;
    agentHandle?: string;
    harness?: string;
  }): Promise<{ apiKey: string; agentHandle: string; emailAddress: string }>;
  verifySignup(apiKey: string, code: string): Promise<{ claimStatus: string }>;
  resendVerification(apiKey: string): Promise<void>;
  client(apiKey: string): Promise<any>;
}

export interface WizardDeps {
  io?: WizardIO;
  env?: NodeJS.ProcessEnv;
  envFilePath?: string;
  // Which env vars were filled from which env file at CLI start (see
  // loadEnvFile). Vars set in `env` but absent here came from the shell.
  envSources?: Map<string, string>;
  sdk?: (baseUrl: string | undefined) => WizardSdk;
  realtimeValidatorFn?: (apiKey: string, model: string) => Promise<RealtimeValidationResult>;
  installAutostartFn?: typeof installAutostart;
  startDaemonFn?: typeof startDaemon;
  restartDaemonFn?: typeof restartDaemon;
  runningDaemonPidFn?: typeof runningDaemonPid;
  confirmTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  cwd?: string;
}

interface Ctx {
  io: WizardIO;
  env: NodeJS.ProcessEnv;
  initialEnv: NodeJS.ProcessEnv;
  envFile: string;
  envSources: Map<string, string>;
  sdk: WizardSdk;
  baseUrl: string | undefined;
  realtimeValidatorFn: (apiKey: string, model: string) => Promise<RealtimeValidationResult>;
  installAutostartFn: typeof installAutostart;
  startDaemonFn: typeof startDaemon;
  restartDaemonFn: typeof restartDaemon;
  runningDaemonPidFn: typeof runningDaemonPid;
  confirmTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  cwd: string;
}

function defaultSdk(baseUrl: string | undefined): WizardSdk {
  const opts = baseUrl ? { baseUrl } : {};
  return {
    async signup(req) {
      const { Inkbox } = await import("@inkbox/sdk");
      return (Inkbox as any).signup(req, opts);
    },
    async verifySignup(apiKey, code) {
      const { Inkbox } = await import("@inkbox/sdk");
      return (Inkbox as any).verifySignup(apiKey, { verificationCode: code }, opts);
    },
    async resendVerification(apiKey) {
      const { Inkbox } = await import("@inkbox/sdk");
      await (Inkbox as any).resendSignupVerification(apiKey, opts);
    },
    async client(apiKey) {
      const { Inkbox } = await import("@inkbox/sdk");
      return new (Inkbox as any)({ apiKey, ...opts });
    },
  };
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Terminals in bracketed-paste mode wrap pastes in ESC[200~ ... ESC[201~, and
// node readline can leak the markers into the answer — which turns a pasted
// verification code or API key into permanent rejection. Strip them.
export function sanitizePasted(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC byte is the point
  return value.replace(/\u001b?\[\s*20[01]~/g, "");
}

export async function runWizard(config: ResolvedConfig, deps: WizardDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const io = deps.io ?? (await makeTerminalIO());
  const baseUrl =
    env.INKBOX_BASE_URL && env.INKBOX_BASE_URL !== DEFAULT_BASE_URL
      ? env.INKBOX_BASE_URL
      : (config.baseUrl ?? undefined);
  const c: Ctx = {
    io,
    env,
    initialEnv: { ...env },
    envFile:
      deps.envFilePath ?? env.INKBOX_OPENCODE_ENV_FILE ?? path.join(gatewayHome(env), ".env"),
    envSources: deps.envSources ?? new Map(),
    sdk: (deps.sdk ?? defaultSdk)(baseUrl),
    baseUrl,
    realtimeValidatorFn: deps.realtimeValidatorFn ?? validateOpenAIRealtime,
    installAutostartFn: deps.installAutostartFn ?? installAutostart,
    startDaemonFn: deps.startDaemonFn ?? startDaemon,
    restartDaemonFn: deps.restartDaemonFn ?? restartDaemon,
    runningDaemonPidFn: deps.runningDaemonPidFn ?? runningDaemonPid,
    confirmTimeoutMs: deps.confirmTimeoutMs ?? START_CONFIRM_TIMEOUT_MS,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    cwd: deps.cwd ?? process.cwd(),
  };
  try {
    return await wizard(c, config);
  } finally {
    if (!deps.io) (io as TerminalIO).close();
  }
}

function save(c: Ctx, name: string, value: string): void {
  saveEnvVar(c.envFile, name, value);
  warnIfShadowed(c, name, value);
  c.env[name] = value; // later steps (and autostart's snapshot) see it live
}

// A var already set when the process started keeps winning over the file we
// just wrote (real env > earlier env files > the wizard's file), so a stale
// shell export or higher-precedence .env silently undoes the setup for every
// future process — the classic symptom is a wizard that works end-to-end
// followed by a doctor/gateway that 401s with an old key.
function warnIfShadowed(c: Ctx, name: string, value: string): void {
  const previous = c.initialEnv[name];
  if (previous === undefined || previous === value) return;
  const source = c.envSources.get(name);
  if (source && path.resolve(source) === path.resolve(c.envFile)) return; // just replaced it
  const { io } = c;
  if (source) {
    io.print(`  warning: ${name} is also set in ${source}, which loads ahead of`);
    io.print(`  ${c.envFile} — remove it there or that stale value wins.`);
  } else {
    io.print(`  warning: your shell exports ${name}, which overrides the value just`);
    io.print("  saved for every new process (doctor, the gateway). Remove the export");
    io.print(`  from your shell profile (e.g. ~/.zshrc) and run \`unset ${name}\`.`);
  }
}

async function wizard(c: Ctx, config: ResolvedConfig): Promise<number> {
  const { io } = c;
  io.print("=== Inkbox + opencode ===");
  io.print("Give your opencode agent its own Inkbox identity — mailbox, phone");
  io.print("number, SMS, iMessage, and voice — so you can talk to it from your");
  io.print("phone while it works.");

  if (config.apiKey && config.identity) {
    io.print("");
    io.print(`Inkbox is already configured for identity '${config.identity}'.`);
    if (!(await io.confirm("  Reconfigure Inkbox?", false))) return 0;
  }

  io.print("");
  io.print("If you do not have an Inkbox API key yet, that is fine.");
  io.print("We can create a fresh agent identity for you via self-signup.");
  const hasKey = await io.confirm("  Do you already have an Inkbox API key?", false);

  const resolved = hasKey ? await apiKeyFlow(c) : await selfSignupFlow(c);
  if (!resolved) return 1;
  const { identity, apiKey } = resolved;

  save(c, "INKBOX_API_KEY", apiKey);
  save(c, "INKBOX_IDENTITY", identity.agentHandle);
  if (c.baseUrl && c.baseUrl !== DEFAULT_BASE_URL) save(c, "INKBOX_BASE_URL", c.baseUrl);

  // Authorization is enforced server-side by Inkbox contact rules; there is
  // no second local allowlist to keep in sync.
  save(c, "INKBOX_ALLOW_ALL_USERS", "true");
  io.print("");
  io.print("Inkbox authorization lives server-side via contact rules:");
  io.print("  https://inkbox.ai/console/contact-rules");

  const client = await c.sdk.client(apiKey);
  const imessageOn = await configureIMessage(c, client, identity.agentHandle);

  let fullIdentity: any;
  try {
    fullIdentity = await client.getIdentity(identity.agentHandle);
  } catch (err) {
    io.print(`  warning: could not load the identity record: ${errText(err)}`);
    fullIdentity = identity;
  }
  const provisioned = await offerDedicatedNumber(c, client, fullIdentity);
  fullIdentity = provisioned.identity;

  printSummary(c, fullIdentity, imessageOn);
  if (provisioned.didProvision) await waitForSmsOptIn(c, client, fullIdentity.phoneNumber);

  if (fullIdentity.phoneNumber || imessageOn) {
    await io.ask("  Press Enter to continue and set up phone call handling");
    if (!(await configurePhoneVoiceStack(c, config, fullIdentity, resolved.authorityIdentity)))
      return 1;
  }

  if (!(await setupSigningKey(c, fullIdentity))) return 1;

  const projectDir = await configureProjectDir(c);
  save(c, "INKBOX_GATEWAY_AGENT", c.env.INKBOX_GATEWAY_AGENT || "inkbox-channel");

  // A live gateway means setup finished the job, so close on that rather than
  // a to-do list. Only when nothing is listening is there a step left.
  if (await configureAutostart(c, projectDir)) {
    printReadyBanner(c, fullIdentity.agentHandle);
    return 0;
  }

  io.print("");
  io.print("Setup complete.");
  io.print("  Start it with:          inkbox-opencode start");
  io.print("  Check it anytime with:  inkbox-opencode doctor");
  return 0;
}

// --- identity acquisition ----------------------------------------------------

interface ResolvedIdentity {
  identity: any;
  apiKey: string;
  authorityIdentity?: any;
}

async function selfSignupFlow(c: Ctx): Promise<ResolvedIdentity | undefined> {
  const { io } = c;
  io.print("");
  io.print("We will create a fresh agent identity for you: an Inkbox-hosted");
  io.print("mailbox plus an API key. A short verification email goes to you.");

  const humanEmail = (await io.ask("  Your email address (for the verification step)")).trim();
  if (!humanEmail.includes("@")) {
    io.print("  error: a valid email address is required for signup.");
    return undefined;
  }
  const handle = (
    await io.ask("  Desired agent handle (globally unique; becomes the mailbox local part)")
  ).trim();
  if (!handle) {
    io.print("  error: an agent handle is required.");
    return undefined;
  }

  io.print("");
  io.print("  Calling agent-signup...");
  let resp: { apiKey: string; agentHandle: string; emailAddress: string };
  try {
    resp = await c.sdk.signup({
      humanEmail,
      noteToHuman: "Setting up an opencode agent on Inkbox.",
      agentHandle: handle,
      harness: "opencode",
    });
  } catch (err) {
    io.print(`  error: signup failed: ${errText(err)}`);
    io.print("  Handles are globally unique; unclaimed agents per email are capped.");
    io.print("  Re-run `inkbox-opencode setup` to try again.");
    return undefined;
  }
  io.print(`  Agent created — mailbox: ${resp.emailAddress}`);
  io.print(`  A verification email was sent to ${humanEmail}.`);

  const MAX_ATTEMPTS = 3;
  let used = 0;
  for (;;) {
    const left = MAX_ATTEMPTS - used;
    const entry = (
      await io.ask(
        left > 0
          ? `  Verification code, or 'resend' for a new email (${left}/${MAX_ATTEMPTS} attempts left)`
          : "  Type 'resend' for a new code",
      )
    ).trim();
    if (entry.toLowerCase() === "resend" || entry.toLowerCase() === "r") {
      try {
        await c.sdk.resendVerification(resp.apiKey);
        io.print(`  Resent. Check ${humanEmail}.`);
        used = 0;
      } catch (err) {
        io.print(`  warning: resend failed: ${errText(err)}`);
      }
      continue;
    }
    if (!entry || left <= 0) continue;
    try {
      const verify = await c.sdk.verifySignup(resp.apiKey, entry);
      io.print(`  Verified — claim status: ${verify.claimStatus}`);
      break;
    } catch (err) {
      used += 1;
      const detail = errText(err);
      io.print(`  Verification failed (${used}/${MAX_ATTEMPTS} attempts used): ${detail}`);
      // The identity cap is enforced at verify time (the migration into your
      // org), so a full org looks exactly like a rejected code. Say so.
      if (/capacit|limit|cannot admit|quota/i.test(detail)) {
        io.print("  This looks like your account is at its identity limit, not a wrong code.");
        io.print("  Free a slot in the Inkbox console (claim or delete an agent), then");
        io.print("  type 'resend' and enter the fresh code.");
      }
      if (used >= MAX_ATTEMPTS) io.print("  This code is now dead. Type 'resend' for a fresh one.");
    }
  }

  return {
    identity: { agentHandle: resp.agentHandle, emailAddress: resp.emailAddress, phoneNumber: null },
    apiKey: resp.apiKey,
  };
}

async function apiKeyFlow(c: Ctx): Promise<ResolvedIdentity | undefined> {
  const { io } = c;
  io.print("");
  const apiKey = (
    await io.ask("  Paste your Inkbox API key (ApiKey_...)", { password: true })
  ).trim();
  if (!apiKey) {
    io.print("  error: no key provided.");
    return undefined;
  }

  let client: any;
  let info: any;
  try {
    client = await c.sdk.client(apiKey);
    info = await client.whoami();
  } catch (err) {
    io.print(`  error: whoami failed: ${errText(err)}`);
    io.print("  Double-check the key and the environment it was issued in.");
    return undefined;
  }
  if (info?.authType && info.authType !== "api_key") {
    io.print("  error: this wizard needs an API key, not a JWT credential.");
    return undefined;
  }
  const subtype = String(info?.authSubtype ?? "");
  io.print(`  Key validated — org ${info?.organizationId ?? "?"}, scope: ${subtype || "unknown"}`);

  if (subtype.startsWith("api_key.agent_scoped")) {
    const identities = await client.listIdentities();
    if (!identities?.length) {
      io.print("  error: agent-scoped key but no identity returned.");
      return undefined;
    }
    const identity = await client.getIdentity(identities[0].agentHandle);
    io.print(`  This API key is bound to identity: ${identity.agentHandle}`);
    return { identity, apiKey };
  }

  if (subtype === "api_key.admin_scoped") return adminFlow(c, client);

  io.print(`  error: unsupported API-key subtype: ${subtype || "unknown"}.`);
  return undefined;
}

// Admin keys can list/pick/create an identity, then get scoped down to a
// per-agent key so the gateway never stores the admin key.
async function adminFlow(c: Ctx, client: any): Promise<ResolvedIdentity | undefined> {
  const { io } = c;
  let identity: any;
  const identities: any[] = (await client.listIdentities().catch(() => [])) ?? [];
  if (identities.length > 0) {
    const labels = identities.map(
      (i: any) => `${i.agentHandle}  -  ${i.emailAddress ?? "no mailbox"}`,
    );
    labels.push("Create a new identity");
    const idx = await io.choose("  Select the identity this gateway should run as:", labels, 0);
    if (idx < identities.length) {
      identity = await client.getIdentity(identities[idx].agentHandle);
    }
  }
  if (!identity) {
    const handle = (await io.ask("  Handle for the new identity (globally unique)")).trim();
    if (!handle) {
      io.print("  error: an agent handle is required.");
      return undefined;
    }
    try {
      identity = await client.createIdentity(handle);
      io.print(`  Created identity ${identity.agentHandle}.`);
    } catch (err) {
      io.print(`  error: could not create the identity: ${errText(err)}`);
      return undefined;
    }
  }

  try {
    const created = await client.apiKeys.create({
      label: `opencode gateway - ${identity.agentHandle}`,
      description:
        "Auto-minted by inkbox-opencode setup. Scoped to one agent identity so the gateway never stores the admin key.",
      scopedIdentityId: identity.id,
    });
    const agentKey = String(created?.apiKey ?? "");
    if (!agentKey) throw new Error("response had no apiKey");
    io.print("  Minted an agent-scoped key for the gateway.");
    return { identity, apiKey: agentKey, authorityIdentity: identity };
  } catch (err) {
    io.print(`  error: could not mint an agent-scoped key: ${errText(err)}`);
    return undefined;
  }
}

// --- channels -----------------------------------------------------------------

async function configureIMessage(c: Ctx, client: any, handle: string): Promise<boolean> {
  const { io } = c;
  io.print("");
  io.print("  --- iMessage ---");
  io.print("  Inkbox can make this agent reachable over iMessage from your iPhone —");
  io.print("  no number to provision; you connect through the Inkbox iMessage router.");

  let identity: any;
  try {
    identity = await client.getIdentity(handle);
  } catch (err) {
    io.print(`  warning: could not load the identity for iMessage setup: ${errText(err)}`);
    return false;
  }
  if (identity.imessageEnabled) {
    io.print("  iMessage is already enabled for this agent.");
    return true;
  }
  if (!(await io.confirm("  Enable iMessage for this agent?", true))) {
    io.print("  Skipped. Rerun `inkbox-opencode setup` anytime to enable iMessage.");
    return false;
  }
  try {
    await identity.update({ imessageEnabled: true });
    io.print("  iMessage enabled. Connect your iPhone via the Inkbox console walkthrough:");
    io.print("  https://inkbox.ai/console");
    return true;
  } catch (err) {
    io.print(`  error: could not enable iMessage: ${errText(err)}`);
    return false;
  }
}

async function offerDedicatedNumber(
  c: Ctx,
  _client: any,
  identity: any,
): Promise<{ identity: any; didProvision: boolean }> {
  const { io } = c;
  io.print("");
  io.print("  --- Dedicated phone number ---");
  if (identity.phoneNumber) {
    io.print(`  Already provisioned: ${identity.phoneNumber.number}`);
    return { identity, didProvision: false };
  }
  io.print("  A local US number gives this agent its own line for SMS and voice.");
  if (!(await io.confirm("  Provision a dedicated phone number now?", true))) {
    io.print("  Skipped. Rerun `inkbox-opencode setup` anytime to add a number.");
    return { identity, didProvision: false };
  }
  try {
    const phone = await identity.provisionPhoneNumber();
    io.print(`  Provisioned: ${phone.number}`);
    io.print("  (new numbers take ~10-15 minutes to fully propagate to carriers)");
    identity.phoneNumber = phone;
    return { identity, didProvision: true };
  } catch (err) {
    io.print("  Dedicated phone numbers are available on Inkbox paid tiers —");
    io.print("  see https://inkbox.ai/pricing for details.");
    io.print(`  (provisioning response: ${errText(err)})`);
    return { identity, didProvision: false };
  }
}

// Poll for the operator's inbound START text so outbound SMS unlocks; the
// operator can skip by answering the prompt.
async function waitForSmsOptIn(c: Ctx, client: any, phone: any): Promise<void> {
  const { io } = c;
  if (!phone?.id) return;
  io.print("");
  io.print("  --- SMS opt-in ---");
  io.print(`  Text START to ${phone.number} from your phone. Without it, the agent`);
  io.print("  cannot send outbound SMS to you. Polling for it now (up to 5 minutes)...");

  const deadline = 300; // poll rounds at ~1s each
  for (let round = 0; round < deadline; round++) {
    try {
      const texts: any[] = (await client.texts.list(phone.id, { limit: 20 })) ?? [];
      const match = texts.find(
        (t: any) =>
          String(t.direction ?? "").toLowerCase() === "inbound" &&
          String(t.text ?? "")
            .trim()
            .toUpperCase() === "START",
      );
      if (match) {
        io.print(`  Got it. SMS opt-in confirmed from ${match.remotePhoneNumber ?? "your phone"}.`);
        return;
      }
    } catch {
      /* transient poll error — keep listening */
    }
    await c.sleep(1000);
  }
  io.print(`  No START seen yet. Text START to ${phone.number} anytime to enable outbound SMS.`);
}

// --- voice / signing key / project dir / autostart ----------------------------

type VoiceAiAuthorityMode = "contact_scoped" | "yolo";

async function adminIdentityForAuthority(c: Ctx, handle: string): Promise<any | undefined> {
  const key = (
    await c.io.ask("  Paste an admin-scoped Inkbox API key for this authority change", {
      password: true,
    })
  ).trim();
  if (!key) {
    c.io.print("  An admin-scoped API key is required to change saved Voice AI authority.");
    return undefined;
  }
  try {
    const client = await c.sdk.client(key);
    const info = await client.whoami();
    if (String(info?.authSubtype ?? "") !== "api_key.admin_scoped") {
      c.io.print("  That credential is not an admin-scoped API key.");
      return undefined;
    }
    return await client.getIdentity(handle);
  } catch (err) {
    c.io.print(
      `  Could not validate the admin-scoped API key: ${errText(err).replaceAll(key, "***")}`,
    );
    return undefined;
  }
}

async function configureVoiceAi(
  c: Ctx,
  identity: any,
  authorityIdentity?: any,
): Promise<{ authorityIdentity?: any } | undefined> {
  if (
    typeof identity.getHostedAgentConfig !== "function" ||
    typeof identity.getIncomingCallAction !== "function" ||
    typeof identity.setIncomingCallAction !== "function"
  ) {
    c.io.print("  Inkbox Voice AI setup requires @inkbox/sdk 0.5.9.");
    return undefined;
  }
  let hosted: any;
  let incoming: any;
  try {
    [hosted, incoming] = await Promise.all([
      identity.getHostedAgentConfig(),
      identity.getIncomingCallAction(),
    ]);
  } catch (err) {
    c.io.print(`  Could not read the current Voice AI configuration: ${errText(err)}`);
    return undefined;
  }
  const previous: VoiceAiAuthorityMode =
    hosted?.authorityMode === "yolo" ? "yolo" : "contact_scoped";
  const authorityIndex = await c.io.choose(
    "  How much authority should Inkbox Voice AI have?",
    [
      "Contact-scoped — tools are limited to the current caller and conversation.",
      "YOLO mode — tools can use the identity's wider authorized capabilities.",
    ],
    previous === "yolo" ? 1 : 0,
  );
  const selected: VoiceAiAuthorityMode = authorityIndex === 1 ? "yolo" : "contact_scoped";
  let adminIdentity = authorityIdentity;
  if (selected !== previous && !adminIdentity) {
    adminIdentity = await adminIdentityForAuthority(c, identity.agentHandle);
    if (!adminIdentity) return undefined;
  }
  let authorityChanged = false;
  let routingAttempted = false;
  try {
    if (selected !== previous) {
      await adminIdentity.setHostedAgentAuthorityMode({ authorityMode: selected });
      authorityChanged = true;
    }
    routingAttempted = true;
    await identity.setIncomingCallAction({
      incomingCallAction: "hosted_agent",
      clientWebsocketUrl: null,
      incomingCallWebhookUrl: null,
    });
  } catch (err) {
    const rollbackErrors: string[] = [];
    if (routingAttempted) {
      try {
        await identity.setIncomingCallAction({
          incomingCallAction: incoming.incomingCallAction,
          clientWebsocketUrl: incoming.clientWebsocketUrl ?? null,
          incomingCallWebhookUrl: incoming.incomingCallWebhookUrl ?? null,
        });
      } catch (rollbackError) {
        rollbackErrors.push(`incoming routing: ${errText(rollbackError)}`);
      }
    }
    if (authorityChanged) {
      try {
        await adminIdentity.setHostedAgentAuthorityMode({ authorityMode: previous });
      } catch (rollbackError) {
        rollbackErrors.push(`authority: ${errText(rollbackError)}`);
      }
    }
    c.io.print(`  Inkbox Voice AI configuration failed: ${errText(err)}`);
    if (rollbackErrors.length) {
      c.io.print(`  warning: remote rollback was incomplete (${rollbackErrors.join("; ")}).`);
    }
    return undefined;
  }
  save(c, "INKBOX_VOICE_STACK", "inkbox_voice_ai");
  save(c, "INKBOX_VOICE_AI_AUTHORITY_MODE", selected);
  save(c, "INKBOX_REALTIME_ENABLED", "false");
  c.io.print("  Inkbox Voice AI is configured for phone calls.");
  c.io.print("  OpenCode will be notified when each call ends.");
  return { authorityIdentity: adminIdentity };
}

function configuredGatewayPublicUrl(config: ResolvedConfig): string | undefined {
  const configuredPublicUrl = config.gateway.publicUrl?.trim().replace(/\/+$/, "");
  return configuredPublicUrl || undefined;
}

function localCallWebsocketUrl(publicUrl: string): string {
  return `${publicUrl.replace(/^http/, "ws")}${CALL_MEDIA_WS_PATH}`;
}

async function configureLocalIncomingCalls(
  c: Ctx,
  config: ResolvedConfig,
  identity: any,
): Promise<boolean> {
  const publicUrl = configuredGatewayPublicUrl(config);
  if (!publicUrl) {
    c.io.print(
      "  Incoming-call routing will be configured when the gateway starts and its public URL is known.",
    );
    return true;
  }
  if (typeof identity.setIncomingCallAction !== "function") {
    c.io.print("  The installed Inkbox SDK cannot configure incoming calls.");
    return false;
  }
  try {
    await identity.setIncomingCallAction({
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: localCallWebsocketUrl(publicUrl),
      incomingCallWebhookUrl: `${publicUrl}${WEBHOOK_PATH}`,
    });
    return true;
  } catch (err) {
    c.io.print(`  Could not configure incoming calls: ${errText(err)}`);
    return false;
  }
}

async function configureRealtime(c: Ctx): Promise<string | undefined> {
  const { io } = c;
  const detected = c.env.INKBOX_REALTIME_API_KEY || c.env.OPENAI_API_KEY || "";
  if (detected) io.print("  Found an OpenAI API key in your environment.");
  const apiKey =
    detected ||
    (await io.ask("  Paste your OpenAI API key for Realtime calls", { password: true })).trim();
  if (!apiKey) {
    io.print("  No key entered. Choose a phone call voice stack again.");
    return undefined;
  }

  io.print(`  Testing OpenAI Realtime access with ${DEFAULT_REALTIME_MODEL}...`);
  try {
    const result = await c.realtimeValidatorFn(apiKey, DEFAULT_REALTIME_MODEL);
    if (!result.ok) throw new Error(result.detail);
  } catch (err) {
    io.print(`  error: OpenAI validation failed (${errText(err).replaceAll(apiKey, "***")}).`);
    io.print("  Choose a phone call voice stack again.");
    return undefined;
  }
  return apiKey;
}

async function configurePhoneVoiceStack(
  c: Ctx,
  config: ResolvedConfig,
  identity: any,
  authorityIdentity?: any,
): Promise<boolean> {
  const configured = c.env.INKBOX_VOICE_STACK ?? config.phoneVoiceStack;
  let defaultIndex =
    configured === "inkbox_voice_ai" ? 0 : configured === "openai_realtime" ? 1 : 2;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    c.io.print("");
    c.io.print("  --- Phone call voice stack ---");
    const selected = await c.io.choose(
      "  Choose how this agent should handle phone calls:",
      [
        "Inkbox Voice AI — Inkbox handles calls on behalf of your agent; OpenCode is notified when the call ends.",
        "OpenAI Realtime API — Bring your own API key; the realtime agent can consult OpenCode for complex tasks.",
        "Inkbox TTS/STT — OpenCode talks through the Inkbox voice stack with increased latency.",
      ],
      defaultIndex,
    );
    defaultIndex = selected;
    const selectedStack: PhoneVoiceStack =
      selected === 0 ? "inkbox_voice_ai" : selected === 1 ? "openai_realtime" : "inkbox_tts_stt";
    if (config.phoneVoiceStackOption && selectedStack !== config.phoneVoiceStackOption) {
      c.io.print(
        `  The plugin option phoneVoiceStack=${config.phoneVoiceStackOption} overrides saved environment selections.`,
      );
      c.io.print("  Update or remove that plugin option, then choose the matching stack here.");
      defaultIndex =
        config.phoneVoiceStackOption === "inkbox_voice_ai"
          ? 0
          : config.phoneVoiceStackOption === "openai_realtime"
            ? 1
            : 2;
      continue;
    }
    if (selected === 0) {
      if (await configureVoiceAi(c, identity, authorityIdentity)) return true;
      continue;
    }
    if (selected === 1) {
      const realtimeApiKey = await configureRealtime(c);
      if (!realtimeApiKey) continue;
      if (!(await configureLocalIncomingCalls(c, config, identity))) continue;
      save(c, "INKBOX_REALTIME_ENABLED", "true");
      save(c, "INKBOX_REALTIME_API_KEY", realtimeApiKey);
      save(c, "INKBOX_VOICE_STACK", "openai_realtime");
      c.io.print("  OpenAI Realtime validated — enabled for calls.");
      return true;
    }
    if (!(await configureLocalIncomingCalls(c, config, identity))) continue;
    save(c, "INKBOX_VOICE_STACK", "inkbox_tts_stt");
    save(c, "INKBOX_REALTIME_ENABLED", "false");
    c.io.print("  Inkbox TTS/STT is configured for phone calls.");
    return true;
  }
  c.io.print("  error: phone call handling could not be configured after 5 attempts.");
  return false;
}

async function setupSigningKey(c: Ctx, identity: any): Promise<boolean> {
  const { io } = c;
  io.print("");
  io.print("  --- Webhook signing key ---");
  io.print("  Inkbox signs inbound webhooks; the gateway needs the matching key.");

  if (await io.confirm("  Do you already have an Inkbox signing key?", false)) {
    const key = (await io.ask("  Paste your Inkbox signing key", { password: true })).trim();
    if (key) {
      save(c, "INKBOX_SIGNING_KEY", key);
      io.print("  Saved signing key. Signature verification enabled.");
      return true;
    }
    io.print("  No key entered; a signing key is required, so we'll mint one now.");
  }

  io.print("  Minting a new key rotates any existing key for this identity —");
  io.print("  any other gateway using the old key will fail verification.");
  if (!(await io.confirm("  Generate a new signing key now?", true))) {
    io.print("  error: a signing key is required; cannot complete setup without one.");
    return false;
  }
  try {
    const minted = await identity.createSigningKey();
    const key = String(minted?.signingKey ?? "");
    if (!key) throw new Error("response had no signingKey");
    save(c, "INKBOX_SIGNING_KEY", key);
    io.print("  Generated and saved signing key. Signature verification enabled.");
    return true;
  } catch (err) {
    io.print(`  error: failed to create a signing key: ${errText(err)}`);
    return false;
  }
}

async function configureProjectDir(c: Ctx): Promise<string> {
  const { io } = c;
  io.print("");
  io.print("  --- Project directory ---");
  io.print("  Gateway sessions read, search, and edit files in this directory.");

  const current = c.env.INKBOX_PROJECT_DIR || c.cwd;
  const answer = (await io.ask("  Directory the agent should work in", { def: current })).trim();
  const chosen = path.resolve(answer || current);
  if (!fs.existsSync(chosen)) {
    try {
      fs.mkdirSync(chosen, { recursive: true });
      io.print(`  Created ${chosen}`);
    } catch (err) {
      io.print(`  warning: could not create ${chosen}: ${errText(err)}`);
    }
  }
  save(c, "INKBOX_PROJECT_DIR", chosen);
  io.print(`  The agent will work in ${chosen}`);
  return chosen;
}

// Returns true when a gateway is running by the time this resolves, so the
// caller can close on a status banner instead of a to-do list.
// Poll for liveness after a start or restart. A gateway that fails to bind is
// gone within a second or two, well after startDaemon has already returned 0.
async function confirmDaemonRunning(c: Ctx): Promise<boolean> {
  const deadline = Date.now() + c.confirmTimeoutMs;
  for (;;) {
    if (c.runningDaemonPidFn() === undefined) {
      c.io.print("  The gateway exited right after starting.");
      c.io.print("  Check the log:  ~/.inkbox-opencode/gateway.log");
      c.io.print("  Then rerun:     inkbox-opencode start");
      return false;
    }
    if (Date.now() >= deadline) return true;
    await c.sleep(START_CONFIRM_POLL_MS);
  }
}

async function configureAutostart(c: Ctx, projectDir: string): Promise<boolean> {
  const { io } = c;
  io.print("");
  io.print("  --- Keep the gateway running ---");
  io.print("  The gateway has to stay running to receive your messages and reply.");

  // `startDaemon` refuses to act on a live PID, so a rerun would leave the
  // gateway on the .env this wizard just replaced. Restart it instead.
  const bringUp = async (): Promise<boolean> => {
    const pid = c.runningDaemonPidFn();
    let code: number;
    if (pid !== undefined) {
      io.print(`  A background gateway is already running (pid ${pid}) on the old config.`);
      io.print("  Restarting it so it picks up the new settings.");
      code = await c.restartDaemonFn();
    } else {
      code = await c.startDaemonFn();
    }
    if (code !== 0) return false;
    return confirmDaemonRunning(c);
  };

  if (await io.confirm("  Start it now and automatically on every boot?", true)) {
    if (await c.installAutostartFn({ projectDirectory: projectDir, env: c.env })) return true;
    io.print("  Couldn't set up boot autostart — starting in the background for now.");
    return bringUp();
  }
  if (await io.confirm("  Start it in the background now (until you reboot)?", true)) {
    return bringUp();
  }
  io.print("  Start it yourself anytime with:  inkbox-opencode start");
  return false;
}

// Closing banner for a setup that ended with a live gateway: names the identity
// the agent now runs as, and the one command worth knowing.
function printReadyBanner(c: Ctx, handle: string): void {
  const rows: Array<[string, string]> = [
    ["Inkbox identity", handle],
    ["Check its health", "inkbox-opencode doctor"],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 1; // +1 for the colon
  const body = [
    "Your OpenCode agent is set up and running on Inkbox.",
    "",
    ...rows.map(([label, value]) => `  ${`${label}:`.padEnd(labelWidth)}  ${value}`),
  ];
  const width = Math.max(...body.map((line) => line.length)) + 4;
  c.io.print("");
  c.io.print(`╭${"─".repeat(width - 2)}╮`);
  for (const line of body) c.io.print(`│ ${line.padEnd(width - 4)} │`);
  c.io.print(`╰${"─".repeat(width - 2)}╯`);
}

function printSummary(c: Ctx, identity: any, imessageOn: boolean): void {
  const { io } = c;
  io.print("");
  io.print("  --- Your agent ---");
  io.print(`  handle:   ${identity.agentHandle}`);
  io.print(`  email:    ${identity.emailAddress ?? "(none)"}`);
  io.print(`  phone:    ${identity.phoneNumber?.number ?? "(none)"}`);
  io.print(`  imessage: ${imessageOn ? "enabled" : "disabled"}`);
}

// --- terminal IO ----------------------------------------------------------------

interface TerminalIO extends WizardIO {
  close(): void;
}

async function makeTerminalIO(): Promise<TerminalIO> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Password prompts mute the echo by intercepting readline's output writes.
  const raw = rl as unknown as {
    _writeToOutput?: (s: string) => void;
    output?: NodeJS.WritableStream;
  };
  const originalWrite = raw._writeToOutput?.bind(rl);
  let muted = false;
  if (originalWrite) {
    raw._writeToOutput = (s: string) => {
      if (!muted) originalWrite(s);
    };
  }

  return {
    print: (line = "") => console.log(line),
    async ask(question, opts = {}) {
      const suffix = opts.def ? ` [${opts.def}]` : "";
      if (opts.password && originalWrite) {
        process.stdout.write(`${question}${suffix}: `);
        muted = true;
        try {
          const answer = sanitizePasted(await rl.question(""));
          process.stdout.write("\n");
          return answer || opts.def || "";
        } finally {
          muted = false;
        }
      }
      const answer = sanitizePasted(await rl.question(`${question}${suffix}: `));
      return answer || opts.def || "";
    },
    async confirm(question, def) {
      const hint = def ? "Y/n" : "y/N";
      const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
      if (!answer) return def;
      return ["y", "yes"].includes(answer);
    },
    async choose(question, options, def) {
      console.log(question);
      for (const [i, opt] of options.entries()) console.log(`    ${i + 1}. ${opt}`);
      for (;;) {
        const answer = (await rl.question(`  Choice [${def + 1}]: `)).trim();
        if (!answer) return def;
        const n = Number.parseInt(answer, 10);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
        console.log(`  Enter a number between 1 and ${options.length}.`);
      }
    },
    close: () => rl.close(),
  };
}
