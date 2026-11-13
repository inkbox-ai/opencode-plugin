import { createHash } from "node:crypto";
import { join } from "node:path";
import { type RemoteCallOptions, RemoteMcp, type RemoteTool } from "@inkbox/sdk/remote-mcp";
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";
import type { InkboxRuntime } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { assertHostedToolAllowed } from "./gateway/hosted-call-registry.js";
import { createStateStore, type DurableTurn, gatewayHome } from "./gateway/state.js";
import type { HostClient } from "./host/types.js";
import { approveOutbound, checkOutboundRecipients } from "./permissions.js";
import { sendTerminalReply } from "./terminal-reply.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const aliases: Record<string, string> = {
  inkbox_lookup_contact: "inkbox_contacts_list",
  inkbox_list_contacts: "inkbox_contacts_list",
  inkbox_get_contact: "inkbox_contact_get",
  inkbox_create_contact: "inkbox_contact_create",
  inkbox_update_contact: "inkbox_contact_update",
  inkbox_delete_contact: "inkbox_contact_delete",
};
type NativeContext = ToolContext & { callID?: string };
type Binding = { parentID: string; turn?: DurableTurn; validate(): Promise<void> };
type Catalog = { remote?: RemoteMcp; tools: RemoteTool[]; held?: boolean };

export class RemoteTools {
  private readonly nativeCalls = new WeakMap<
    object,
    { sessionID: string; callID: string; tool: string }
  >();
  private readonly catalogs = new Map<string, Promise<Catalog>>();
  private closed = false;
  constructor(
    private readonly runtime: InkboxRuntime,
    private readonly config: ResolvedConfig,
    private readonly host: HostClient,
    private readonly directory: string,
    private readonly home = gatewayHome(),
  ) {}

  before(
    input: { sessionID: string; callID: string; tool: string },
    output: { args: unknown },
  ): void {
    if (output.args && typeof output.args === "object") this.nativeCalls.set(output.args, input);
  }

  wrap(tools: Record<string, ToolDefinition>): Record<string, ToolDefinition> {
    for (const [name, definition] of Object.entries(tools)) {
      if (!aliases[name]) continue;
      const local = definition.execute;
      tools[name] = {
        ...definition,
        execute: async (args, context) => {
          const source = await this.binding(context);
          const catalog = await this.catalog(context, source);
          if (catalog.held) return local(args, context);
          const operation = this.operation(name, args, context, source);
          return this.result(
            await this.call(
              name,
              aliases[name],
              contactArguments(name, args, operation),
              args,
              context,
              source,
              catalog,
            ),
          );
        },
      };
    }
    return {
      ...tools,
      inkbox_remote_tools: {
        description:
          "Read the current Inkbox tool catalog with complete JSON schemas and annotations. Use the exact discovered schema before calling a remote tool.",
        args: { name: z.string().optional(), offset: z.number().int().nonnegative().optional() },
        execute: async (args: { name?: string; offset?: number }, context) => {
          assertHostedToolAllowed(context.sessionID, "inkbox_remote_tools");
          const source = await this.binding(context);
          const catalog = await this.catalog(context, source);
          if (!catalog.remote) throw new Error("Remote tools are unavailable for this identity.");
          const offset = args.offset ?? 0;
          if (offset > catalog.tools.length) throw new Error("Invalid catalog offset.");
          await source.validate();
          return this.result({
            tools: args.name
              ? catalog.tools.filter((t) => t.name === args.name)
              : catalog.tools.slice(offset, offset + 32),
            next_offset: !args.name && offset + 32 < catalog.tools.length ? offset + 32 : null,
          });
        },
      },
      inkbox_remote_call: {
        description:
          "Execute a tool discovered by inkbox_remote_tools using its full JSON arguments. Preserves the native call identity when reconciling an uncertain result.",
        args: { name: z.string(), arguments: z.record(z.string(), z.unknown()) },
        execute: async (args: { name: string; arguments: Record<string, unknown> }, context) => {
          const source = await this.binding(context);
          const catalog = await this.catalog(context, source);
          return this.result(
            await this.call(
              "inkbox_remote_call",
              args.name,
              args.arguments,
              args,
              context,
              source,
              catalog,
            ),
          );
        },
      },
      inkbox_reply_current: {
        description:
          "Send the final text reply to the admitted incoming email or direct SMS. The destination comes from that message. Use ordinary tools for progress or unrelated messages.",
        args: { text: z.string().min(1).max(12000) },
        execute: async (args: { text: string }, context) => {
          const source = await this.binding(context);
          const catalog = await this.catalog(context, source);
          if (!source.turn || !catalog.remote)
            throw new Error("A final reply requires an admitted incoming message.");
          const result = await sendTerminalReply(
            catalog.remote,
            this.runtime,
            source.turn,
            args.text,
            source.validate,
            this.home,
            (name, payload, operation, path, submitted) =>
              this.call("inkbox_reply_current", name, payload, args, context, source, catalog, {
                callIdentity: operation,
                journalPath: path,
                beforeSubmit: submitted,
              }),
          );
          return this.result(result);
        },
      },
    };
  }

  private result(value: unknown) {
    return { output: JSON.stringify(value), metadata: { inkboxRemote: value } };
  }

  private operation(name: string, args: object, ctx: NativeContext, source: Binding): string {
    const observed = this.nativeCalls.get(args);
    const call =
      ctx.callID ??
      (observed?.sessionID === ctx.sessionID && observed.tool === name
        ? observed.callID
        : undefined);
    if (!call) throw new Error("A trusted native tool-call identity is required.");
    return hash([ctx.sessionID, source.parentID, call]);
  }

  private async binding(ctx: ToolContext): Promise<Binding> {
    const read = async () => {
      ctx.abort.throwIfAborted();
      if (this.closed) throw new Error("The tool owner has closed.");
      const response = await this.host.session.message({
        path: { id: ctx.sessionID, messageID: ctx.messageID },
        query: { directory: this.directory },
      });
      const info = response.data?.info;
      if (
        !info ||
        info.id !== ctx.messageID ||
        info.sessionID !== ctx.sessionID ||
        info.role !== "assistant" ||
        typeof info.parentID !== "string" ||
        !info.parentID
      )
        throw new Error("The native tool source is unavailable.");
      return info.parentID;
    };
    const parentID = await read();
    const state = createStateStore(this.home);
    const matches = state
      .listTurns()
      .filter((t) => t.sessionID === ctx.sessionID && t.messageID === parentID);
    if (matches.length > 1) throw new Error("The incoming tool source is ambiguous.");
    const turn = matches[0];
    const validate = async () => {
      if ((await read()) !== parentID) throw new Error("The native tool source changed.");
      if (turn) {
        const current = state.getTurn(turn.id);
        if (
          !current ||
          current.state !== "submitted" ||
          current.executionFenced ||
          current.ownerId !== turn.ownerId ||
          current.messageID !== parentID
        )
          throw new Error("The incoming message no longer authorizes this tool.");
      }
    };
    await validate();
    return { parentID, turn, validate };
  }

  private async catalog(ctx: ToolContext, source: Binding): Promise<Catalog> {
    const key = hash([ctx.sessionID, source.parentID]);
    let pending = this.catalogs.get(key);
    if (!pending) {
      if (this.catalogs.size >= 4096)
        throw new Error("Remote catalog capacity reached; finish and reconnect native sessions.");
      pending = (async () => {
        const client = await this.runtime.getClient();
        const account = await client.whoami();
        if (
          ["api_key.admin_scoped", "api_key.agent_scoped.unclaimed"].includes(
            account.authSubtype ?? "",
          )
        )
          return { tools: [], held: true };
        if (account.authSubtype !== "api_key.agent_scoped.claimed")
          throw new Error("Remote tools require current claimed identity authority.");
        const identity = await this.runtime.getIdentity();
        const remote = new RemoteMcp({
          apiKey: client._apiKey,
          baseUrl: client._baseUrl,
          identity: identity.id,
          journalPath: join(this.home, "remote-calls", hash(ctx.sessionID)),
        });
        return { remote, tools: await remote.refresh({ signal: ctx.abort }) };
      })();
      this.catalogs.set(key, pending);
    }
    const result = await pending;
    await source.validate();
    return result;
  }

  private async call(
    local: string,
    name: string,
    args: Record<string, unknown>,
    nativeArgs: object,
    ctx: ToolContext,
    source: Binding,
    catalog: Catalog,
    options: Partial<RemoteCallOptions> = {},
  ) {
    assertHostedToolAllowed(ctx.sessionID, local);
    if (!catalog.remote) throw new Error("Remote tools are unavailable for this identity.");
    const operation = this.operation(local, nativeArgs, ctx, source);
    if (this.config.outbound.allowedRecipients.length) {
      const descriptor = catalog.tools.find((tool) => tool.name === name);
      if (descriptor?.annotations?.readOnlyHint !== true) {
        const approved = args.approved_recipients as
          | { to?: unknown; cc?: unknown; bcc?: unknown }
          | undefined;
        const recipients =
          name === "inkbox_email_reply" && approved
            ? [approved.to, approved.cc, approved.bcc].flatMap((value) =>
                Array.isArray(value) ? value : [],
              )
            : name === "inkbox_text_send" && Array.isArray(args.to)
              ? args.to
              : undefined;
        if (
          !recipients ||
          !recipients.length ||
          recipients.some((value) => typeof value !== "string")
        )
          throw new Error(
            "This remote operation cannot be checked against the configured recipient allowlist. Use the corresponding local tool.",
          );
        const blocked = checkOutboundRecipients(
          recipients as string[],
          this.config.outbound.allowedRecipients,
        );
        if (blocked) throw new Error(blocked);
      }
    }
    const incoming =
      source.turn?.kind === "normal" &&
      source.turn.deliver &&
      source.turn.replyTarget &&
      !source.turn.companion;
    const permission = incoming
      ? this.config.gateway.outboundApproval
      : this.config.outbound.approval;
    if (permission !== "auto") {
      await approveOutbound(
        ctx,
        {
          ...this.config,
          outbound: { ...this.config.outbound, approval: "ask", allowedRecipients: [] },
        },
        {
          tool: "inkbox_remote_call",
          recipients: [],
          patterns: [name],
          summary: `Run Inkbox tool ${name}`,
          metadata: {
            inkboxRemoteTool: name,
            inkboxReadOnly: catalog.tools.find((tool) => tool.name === name)?.annotations
              ?.readOnlyHint,
          },
        },
      );
    }
    await source.validate();
    return catalog.remote.call(name, args, {
      ...options,
      callIdentity: options.callIdentity ?? operation,
      beforeExecute: source.validate,
      signal: ctx.abort,
    });
  }

  close(): void {
    this.closed = true;
    this.catalogs.clear();
  }
}

export function contactArguments(
  name: string,
  args: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  const values = Object.fromEntries(
    Object.entries(args)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        value,
      ]),
  );
  if (name === "inkbox_lookup_contact" && Object.values(values).filter(Boolean).length !== 1)
    throw new Error("Specify one lookup criterion.");
  if (name === "inkbox_delete_contact") return { ...values, idempotency_key: operation };
  if (!["inkbox_create_contact", "inkbox_update_contact"].includes(name)) return values;
  const { contact_id, ...fields } = values;
  for (const key of ["emails", "phones"]) {
    const entries = fields[key];
    if (Array.isArray(entries))
      fields[key] = entries.map((entry) => ({
        [key === "phones" ? "value_e164" : "value"]: entry.value,
        label: entry.label ?? null,
        is_primary: entry.isPrimary ?? false,
      }));
  }
  return {
    ...(name === "inkbox_create_contact" ? { contact: fields } : { contact_id, patch: fields }),
    idempotency_key: operation,
  };
}
