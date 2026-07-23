import type { OpencodeClient } from "@opencode-ai/sdk";
import type { ActiveA2ATurn } from "../a2a-context.js";
import type { InkboxRuntime } from "../client.js";
import type { ResolvedConfig } from "../config.js";
import type { StateStore } from "./state.js";

export interface GatewayLogger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

// Everything gateway modules are allowed to depend on. The same deps object
// works in both deployments: sidecar (opencode client points at a server URL)
// and in-plugin (opencode client is the host-provided one). Gateway state
// never crosses process boundaries except through `opencode` (server-side)
// or `state` (the state file).
export interface GatewayDeps {
  inkbox: InkboxRuntime;
  opencode: OpencodeClient;
  config: ResolvedConfig;
  state: StateStore;
  logger: GatewayLogger;
  // Directory gateway sessions are created against.
  directory: string;
}

export type Channel = "email" | "sms" | "imessage" | "voice";

// A peer agent identity the backend resolved for an inbound sender. Webhooks
// carry these under `data.agent_identities`; a sender with no contact match
// but exactly one resolved identity is labeled with it instead of unknown.
export interface SenderAgentIdentity {
  id: string;
  handle?: string;
  displayName?: string;
}

// A verified, parsed inbound message ready for session dispatch.
export interface InboundMessage {
  channel: Channel;
  // Stable per-human key: resolved contact id when available, else a
  // per-channel thread key, else the raw sender address.
  chatKey: string;
  // Sender address: email address or E.164 number.
  from: string;
  // Channel-native conversation identifiers.
  conversationId?: string;
  threadId?: string;
  subject?: string;
  // Provider message id (dedup) and, for email, the RFC 5322 Message-ID
  // used to thread replies.
  messageId?: string;
  rfcMessageId?: string;
  contactId?: string;
  contactName?: string;
  contactCompany?: string;
  contactEmails?: string[];
  contactPhones?: string[];
  contactNotes?: string;
  // The sender's resolved peer agent identity; set only when no contact
  // matched and the identity is unambiguous.
  senderAgent?: SenderAgentIdentity;
  text: string;
  // Local paths of downloaded attachments/media, appended to the framed
  // message so the agent can read them.
  mediaPaths: string[];
  // Number of rapid-fire fragments merged into this message (burst batching);
  // absent or 1 for a normal single message.
  burst?: number;
  // Present when the message arrived in a group conversation.
  group?: { participantCount: number; participants?: string[] };
}

// Where a session's replies are delivered — always the last-used modality.
export interface ReplyTarget {
  channel: Channel;
  to?: string;
  conversationId?: string;
  subject?: string;
  rfcMessageId?: string;
}

// "normal" turns are interruptible by newer inbound messages; "capture"
// turns (delivery failures, external events, post-call actions) always run
// to completion and never deliver their text as a channel reply by default.
export type TurnKind = "normal" | "capture";

export interface TurnRequest {
  kind: TurnKind;
  // Fully framed message text (channel tag + body + media paths).
  text: string;
  // Deliver the assistant's reply to replyTarget when true.
  deliver: boolean;
  replyTarget?: ReplyTarget;
}

export interface SessionManager {
  // Enqueue a normal turn for this message's chatKey (interrupts an
  // in-flight normal turn per the interrupt semantics).
  handleInbound(msg: InboundMessage): Promise<void>;
  // Run a capture turn; resolves with the assistant text (not delivered).
  runCapture(chatKey: string, text: string): Promise<string | undefined>;
  // Run an already-framed turn and return the assistant text without
  // delivering it anywhere (used by the voice bridge to speak the reply).
  runText(chatKey: string, framedText: string): Promise<string | undefined>;
  runA2A(chatKey: string, framedText: string, context: ActiveA2ATurn): Promise<string | undefined>;
  abortA2A(chatKey: string, taskId: string): Promise<boolean>;
  // Control-command support.
  resetSession(chatKey: string): Promise<void>;
  abortTurn(chatKey: string): Promise<boolean>;
  status(chatKey: string): { busy: boolean; sessionID?: string };
  // Stop accepting work and wait for in-flight turns.
  close(): Promise<void>;
}

// Raw verified webhook: the provider that authenticated it plus the parsed
// body. Routing keys off the verified source, never the body's claims.
export interface VerifiedEvent {
  provider: string;
  verified: boolean;
  eventType?: string;
  requestId?: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface WebhookProvider {
  name: string;
  // Does this request carry my fingerprint (headers)?
  matches(headers: Record<string, string>): boolean;
  // Verify the raw body against my secret. Fail closed: no secret => false.
  verify(input: {
    body: Buffer;
    headers: Record<string, string>;
    secret: string | undefined;
  }): Promise<boolean> | boolean;
  // Env var the secret is read from (Inkbox itself uses the signing key).
  secretEnvVar(): string | undefined;
}

export interface GatewayHandle {
  publicUrl: string;
  // Rejects when the inbound transport dies after startup; the sidecar exits
  // nonzero on it so a service manager restarts (and reconnects) the gateway.
  failed?: Promise<void>;
  close(): Promise<void>;
}
