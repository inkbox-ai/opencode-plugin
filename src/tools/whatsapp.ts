import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { formatJson } from "../format.js";
import { readFileWithCap } from "../gateway/media.js";
import { createStateStore } from "../gateway/state.js";
import { approveOutbound } from "../permissions.js";
import {
  assertWhatsAppOwner,
  assertWhatsAppText,
  prepareWhatsApp,
  publicWhatsAppPolicy,
  WHATSAPP_MAX_MEDIA_BYTES,
  whatsappToolOwner,
} from "../whatsapp-native.js";
import type { RegisteredTool, ToolDeps } from "./types.js";

export function whatsappTools(deps: ToolDeps): RegisteredTool[] {
  const page = {
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  };
  type Spec = [
    string,
    string,
    Record<string, z.ZodType>,
    (args: any, ctx: any) => Promise<unknown>,
  ];
  const read = (method: string) => async (args: any) => {
    const identity = await deps.runtime.getIdentity();
    const call = (identity as any)[method];
    if (typeof call !== "function")
      throw new Error("WhatsApp requires Inkbox SDK 0.7.21 or newer.");
    if (method === "getWhatsAppStatus") {
      const status = await call.call(identity);
      let limits = null;
      try {
        if (typeof identity.getWhatsAppLimits === "function")
          limits = await identity.getWhatsAppLimits();
      } catch {
        /* Older API: status and history remain usable. */
      }
      return { status, limits };
    }
    if (method === "getWhatsAppConversation") return call.call(identity, args.conversationId);
    if (method === "getWhatsAppMessage") return call.call(identity, args.messageId);
    if (method === "getWhatsAppMedia") return call.call(identity, args.mediaId);
    if (method === "markWhatsAppRead")
      return call.call(identity, args.conversationId, args.throughMessageId);
    return call.call(identity, args);
  };
  const specs: Spec[] = [
    [
      "get_whatsapp_status",
      "Read current dedicated WhatsApp availability. Request Access in the console; tools cannot grant it.",
      {},
      read("getWhatsAppStatus"),
    ],
    [
      "list_whatsapp_conversations",
      "List one-to-one WhatsApp conversations and local unread counts.",
      page,
      read("listWhatsAppConversations"),
    ],
    [
      "get_whatsapp_conversation",
      "Read one WhatsApp conversation's metadata.",
      { conversationId: z.string() },
      read("getWhatsAppConversation"),
    ],
    [
      "list_whatsapp_messages",
      "List WhatsApp messages newest first.",
      { ...page, conversationId: z.string() },
      read("listWhatsAppMessages"),
    ],
    [
      "get_whatsapp_message",
      "Read sending and delivery state without resending.",
      { messageId: z.string() },
      read("getWhatsAppMessage"),
    ],
    [
      "get_whatsapp_media",
      "Renew temporary media access by its owned ID.",
      { mediaId: z.string() },
      read("getWhatsAppMedia"),
    ],
    [
      "mark_whatsapp_read",
      "Mark local history read; no remote read receipt.",
      { conversationId: z.string(), throughMessageId: z.string() },
      read("markWhatsAppRead"),
    ],
    [
      "lookup_whatsapp_send",
      "Read-only recovery by the original key. Never resend an uncertain attempt.",
      { idempotencyKey: z.string() },
      async (args) => {
        const identity = await deps.runtime.getIdentity();
        return {
          messageId: await (await deps.runtime.getClient()).messageSends.lookup({
            senderKind: "whatsapp_identity",
            senderId: identity.id,
            operation: "whatsapp.send",
            idempotencyKey: args.idempotencyKey,
          }),
        };
      },
    ],
    [
      "upload_whatsapp_media",
      "Upload one authorized local file (protocol maximum 20 MiB, current limits may be lower). Retain the owned media ID.",
      { mediaPath: z.string() },
      async (args, ctx) => {
        const owner = await whatsappToolOwner(ctx.sessionID, ctx, deps.opencode);
        await ctx.ask({
          permission: "inkbox_upload_whatsapp_media",
          patterns: [args.mediaPath],
          always: [args.mediaPath],
          metadata: { summary: "Upload this local file to WhatsApp media" },
        });
        assertWhatsAppOwner(owner);
        if (ctx.abort?.aborted) throw new Error("The originating tool was cancelled.");
        const content = await readFileWithCap(args.mediaPath, WHATSAPP_MAX_MEDIA_BYTES, "upload");
        assertWhatsAppOwner(owner);
        if (ctx.abort?.aborted) throw new Error("The originating tool was cancelled.");
        return (await deps.runtime.getIdentity()).uploadWhatsAppMedia({
          content,
          filename: basename(args.mediaPath),
        });
      },
    ],
    [
      "send_whatsapp",
      "Send one-to-one WhatsApp text and one owned media ID. Normal final answers reply automatically; do not duplicate them. Keep the original key/media ID after uncertainty.",
      {
        to: z.string().optional(),
        conversationId: z.string().optional(),
        text: z.string().optional(),
        mediaId: z.string().optional(),
        idempotencyKey: z.string().optional(),
      },
      async (args, ctx) => {
        assertWhatsAppText(args.text ?? "");
        if (
          Boolean(args.to) === Boolean(args.conversationId) ||
          !(args.text?.trim() || args.mediaId)
        )
          throw new Error("Use one recipient or conversation and text or one owned media ID.");
        const store = createStateStore();
        const owner = await whatsappToolOwner(ctx.sessionID, ctx, deps.opencode, store);
        const identity = await deps.runtime.getIdentity();
        const conversation = args.conversationId
          ? await identity.getWhatsAppConversation(args.conversationId)
          : undefined;
        if (conversation?.isGroup || (conversation && conversation.participants.length !== 1))
          throw new Error("Only one-to-one WhatsApp is supported.");
        const recipients = args.to ? [args.to] : (conversation?.participants ?? []);
        await approveOutbound(ctx, deps.config, {
          tool: "inkbox_send_whatsapp",
          recipients,
          summary: "Send requested WhatsApp message",
        });
        assertWhatsAppOwner(owner, store);
        if (ctx.abort?.aborted) throw new Error("The originating tool was cancelled.");
        if (owner?.whatsappSource && owner.whatsappSource.identityId !== identity.id)
          throw new Error("The originating identity changed.");
        const payload = {
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.mediaId ? { mediaIds: [args.mediaId] } : {}),
        };
        const source = owner?.nativeOwner?.turnId ?? ctx.messageID;
        const key =
          args.idempotencyKey ??
          `opencode:whatsapp-tool:${createHash("sha256")
            .update(JSON.stringify([identity.id, source, args.to, args.conversationId, payload]))
            .digest("hex")}`;
        const sameConversation =
          owner?.channel === "whatsapp" &&
          (args.conversationId === owner.conversationId || (args.to && args.to === owner.sender));
        const target = {
          ...(owner ?? {}),
          channel: "whatsapp" as const,
          to: sameConversation ? undefined : args.to,
          conversationId: sameConversation ? owner.conversationId : args.conversationId,
          messageId: owner?.messageId ?? ctx.messageID,
        };
        if (!sameConversation) delete target.whatsappSource;
        const message = await (await prepareWhatsApp(identity, target, payload, store, key))();
        return { message, idempotencyKey: key, mediaId: args.mediaId ?? null };
      },
    ],
  ];
  return specs.map(([name, description, args, execute]) => ({
    name: `inkbox_${name}`,
    group: "whatsapp",
    defaultEnabled: true,
    definition: {
      description,
      args,
      async execute(input, ctx) {
        const owner = await whatsappToolOwner(ctx.sessionID, ctx, deps.opencode);
        assertWhatsAppOwner(owner);
        if (ctx.abort?.aborted) throw new Error("The originating tool was cancelled.");
        try {
          const result = await execute(input, ctx);
          assertWhatsAppOwner(owner);
          return formatJson(result);
        } catch (error) {
          const policy = publicWhatsAppPolicy(error);
          if (!policy) throw error;
          return formatJson({
            ...policy,
            idempotencyKey:
              error && typeof error === "object" && "idempotencyKey" in error
                ? error.idempotencyKey
                : undefined,
            mediaId:
              error && typeof error === "object" && "mediaId" in error ? error.mediaId : undefined,
          });
        }
      },
    },
  }));
}
