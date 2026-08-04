import * as fs from "node:fs";
import * as path from "node:path";
import { gatewayHome } from "../gateway/state.js";
import { restartDaemon, runningDaemonPid, startDaemon } from "./daemon.js";
import { saveEnvVar } from "./env-file.js";

export interface BootstrapOptions {
  identity: string;
  apiKey: string;
  baseUrl?: string;
  projectDir?: string;
  voiceAi?: boolean;
  voiceAiInstructions?: string;
  rotateSigningKey?: boolean;
  startGateway?: boolean;
}

export interface BootstrapResult {
  status: "configured" | "requires_human" | "error";
  identity?: string;
  actions?: string[];
  gatewayRunning?: boolean;
  humanActions?: string[];
  error?: string;
}

type InkboxClient = any;

const handle = (value: string): string => value.trim().replace(/^@/, "").trim();

function save(name: string, value: string): void {
  if (!value) return;
  const envFile =
    process.env.INKBOX_OPENCODE_ENV_FILE ?? path.join(gatewayHome(process.env), ".env");
  saveEnvVar(envFile, name, value);
  process.env[name] = value;
}

async function clientFor(apiKey: string, baseUrl?: string): Promise<InkboxClient> {
  const { Inkbox } = await import("@inkbox/sdk");
  return new (Inkbox as any)({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

async function identityForAgentKey(client: InkboxClient, expected: string): Promise<any> {
  const identities = (await client.listIdentities()) ?? [];
  if (!identities.some((item: any) => handle(String(item.agentHandle ?? "")) === expected)) {
    throw new Error("The API key is not scoped to the requested identity.");
  }
  return client.getIdentity(expected);
}

async function resolveCredentials(
  apiKey: string,
  expected: string,
  baseUrl: string | undefined,
  actions: string[],
): Promise<{ apiKey: string; identity: any; client: InkboxClient }> {
  const client = await clientFor(apiKey, baseUrl);
  const info = await client.whoami();
  if (String(info?.authType ?? "") !== "api_key") {
    throw new Error("Bootstrap requires an Inkbox API key.");
  }
  const subtype = String(info?.authSubtype ?? "");
  if (subtype === "api_key.agent_scoped.claimed") {
    return { apiKey, identity: await identityForAgentKey(client, expected), client };
  }
  if (subtype === "api_key.agent_scoped.unclaimed") {
    throw new Error("The API key is not attached to a claimed identity yet.");
  }
  if (subtype !== "api_key.admin_scoped") {
    throw new Error("Use an agent-scoped or admin-scoped Inkbox API key.");
  }

  const savedKey = String(process.env.INKBOX_API_KEY ?? "").trim();
  if (savedKey && handle(String(process.env.INKBOX_IDENTITY ?? "")) === expected) {
    try {
      const savedClient = await clientFor(savedKey, baseUrl);
      const savedInfo = await savedClient.whoami();
      if (String(savedInfo?.authSubtype ?? "") === "api_key.agent_scoped.claimed") {
        actions.push("reused_saved_agent_key");
        return {
          apiKey: savedKey,
          identity: await identityForAgentKey(savedClient, expected),
          client: savedClient,
        };
      }
    } catch {
      // Mint a replacement scoped key below.
    }
  }

  const identity = await client.getIdentity(expected);
  const created = await client.apiKeys.create({
    label: `OpenCode gateway - ${expected}`,
    description: "Agent-scoped key created by the OpenCode Inkbox bootstrap.",
    scopedIdentityId: identity.id,
  });
  const scopedKey = String(created?.apiKey ?? "");
  if (!scopedKey) throw new Error("Inkbox did not return the new agent-scoped API key.");
  actions.push("minted_agent_scoped_key");
  const scopedClient = await clientFor(scopedKey, baseUrl);
  return {
    apiKey: scopedKey,
    identity: await scopedClient.getIdentity(expected),
    client: scopedClient,
  };
}

async function defaultVoiceInstructions(identity: any, client: InkboxClient): Promise<string> {
  const agentHandle = handle(String(identity.agentHandle ?? ""));
  const channels: string[] = [];
  const email = identity.emailAddress ?? identity.mailbox?.emailAddress;
  const phone = identity.phoneNumber?.number;
  const tunnel = identity.tunnel?.publicHost;
  const dedicated = identity.imessageNumber?.number;
  if (email) channels.push(`Email: ${email}.`);
  if (phone) channels.push(`VoIP phone: ${phone}.`);
  if (tunnel) channels.push(`Public address: https://${tunnel}.`);
  if (dedicated) {
    channels.push(`Dedicated iMessage line: ${dedicated}.`);
  } else if (identity.imessageEnabled) {
    try {
      const triage = await client.imessages.getTriageNumber();
      const command = String(triage?.connectCommand ?? `connect @${agentHandle}`);
      if (triage?.number) channels.push(`Shared iMessage: text '${command}' to ${triage.number}.`);
    } catch {
      channels.push("Shared iMessage is enabled; use the current Inkbox connection instructions.");
    }
  }
  const configured =
    channels.join(" ") || "No direct communication channel is currently configured.";
  return `You are the hosted voice interface for Inkbox agent @${agentHandle}. Help callers connect using only these configured channels. ${configured}`;
}

async function configureVoice(
  identity: any,
  client: InkboxClient,
  requested?: string,
): Promise<void> {
  const hosted = await identity.getHostedAgentConfig();
  const instructions =
    requested ?? hosted?.instructions ?? (await defaultVoiceInstructions(identity, client));
  if (instructions.length > 8000)
    throw new Error("Voice AI instructions must be 8,000 characters or fewer.");
  if (hosted?.instructions !== instructions) {
    await identity.setHostedAgentConfig({
      voice: hosted?.voice,
      model: hosted?.model,
      instructions,
    });
  }
  const incoming = await identity.getIncomingCallAction();
  if (
    incoming?.incomingCallAction !== "hosted_agent" ||
    incoming?.clientWebsocketUrl != null ||
    incoming?.incomingCallWebhookUrl != null
  ) {
    await identity.setIncomingCallAction({
      incomingCallAction: "hosted_agent",
      clientWebsocketUrl: null,
      incomingCallWebhookUrl: null,
    });
  }
  save("INKBOX_VOICE_STACK", "inkbox_voice_ai");
  save("INKBOX_VOICE_AI_AUTHORITY_MODE", String(hosted?.authorityMode ?? "contact_scoped"));
  save("INKBOX_REALTIME_ENABLED", "false");
}

async function configureSigning(
  identity: any,
  rotate: boolean,
  sameIdentity: boolean,
  actions: string[],
): Promise<string | undefined> {
  const status = await identity.getSigningKeyStatus();
  const configured = Boolean(status?.configured);
  if (process.env.INKBOX_SIGNING_KEY?.trim() && sameIdentity && configured && !rotate) {
    save("INKBOX_REQUIRE_SIGNATURE", "true");
    actions.push("reused_local_signing_key");
    return undefined;
  }
  if (configured && !rotate) {
    return "A signing key already exists but is unavailable in this OpenCode profile. Set INKBOX_SIGNING_KEY or rerun with --rotate-signing-key.";
  }
  const created = await identity.createSigningKey();
  const signingKey = String(created?.signingKey ?? "");
  if (!signingKey) throw new Error("Inkbox did not return the new signing key.");
  save("INKBOX_SIGNING_KEY", signingKey);
  save("INKBOX_REQUIRE_SIGNATURE", "true");
  actions.push(configured ? "rotated_signing_key" : "created_signing_key");
  return undefined;
}

async function ensureGateway(actions: string[]): Promise<boolean> {
  const running = runningDaemonPid() !== undefined;
  const code = running ? await restartDaemon() : await startDaemon();
  actions.push(running ? "restarted_gateway" : "started_gateway_process");
  if (code !== 0) return false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (runningDaemonPid() !== undefined) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const identityHandle = handle(options.identity);
  if (!identityHandle) return { status: "error", error: "identity is required" };
  if (!options.apiKey.trim()) return { status: "error", error: "API key is required" };
  const actions: string[] = [];
  const secrets = [options.apiKey.trim()];
  try {
    const previous = handle(String(process.env.INKBOX_IDENTITY ?? ""));
    const resolved = await resolveCredentials(
      options.apiKey.trim(),
      identityHandle,
      options.baseUrl,
      actions,
    );
    secrets.push(resolved.apiKey);
    save("INKBOX_API_KEY", resolved.apiKey);
    save("INKBOX_IDENTITY", identityHandle);
    if (options.baseUrl) save("INKBOX_BASE_URL", options.baseUrl);
    if (options.projectDir) save("INKBOX_PROJECT_DIR", path.resolve(options.projectDir));
    save("INKBOX_ALLOW_ALL_USERS", "true");
    actions.push("saved_opencode_configuration");
    if (options.voiceAi) {
      await configureVoice(resolved.identity, resolved.client, options.voiceAiInstructions);
      actions.push("configured_voice_ai");
    }
    const blocker = await configureSigning(
      resolved.identity,
      options.rotateSigningKey === true,
      !previous || previous === identityHandle,
      actions,
    );
    if (blocker) {
      return {
        status: "requires_human",
        identity: identityHandle,
        actions,
        humanActions: [blocker],
      };
    }
    let gatewayRunning = false;
    if (options.startGateway) {
      gatewayRunning = await ensureGateway(actions);
      if (!gatewayRunning) {
        return {
          status: "error",
          identity: identityHandle,
          actions,
          error: "OpenCode gateway did not become ready. Check ~/.inkbox-opencode/gateway.log.",
        };
      }
    }
    return { status: "configured", identity: identityHandle, actions, gatewayRunning };
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of secrets) message = message.replaceAll(secret, "[redacted]");
    return { status: "error", identity: identityHandle, actions, error: message };
  }
}

export function readInstructionsFile(file: string | undefined): string | undefined {
  return file ? fs.readFileSync(file, "utf-8") : undefined;
}
