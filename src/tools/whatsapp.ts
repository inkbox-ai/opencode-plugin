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
  whatsappRecipients,
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
      throw new Error("WhatsApp requires Inkbox SDK 0.7.24 or newer.");
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
      "List direct and group WhatsApp conversations and local unread counts.",
      { ...page, includeGroups: z.boolean().optional() },
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
      {
        ...page,
        conversationId: z.string().optional(),
        includeGroups: z.boolean().optional(),
        threadId: z.string().optional(),
      },
      read("listWhatsAppMessages"),
    ],
    [
      "get_whatsapp_message",
      "Read sending and delivery state without resending.",
      { messageId: z.string() },
      read("getWhatsAppMessage"),
    ],
    [
      "get_whatsapp_thread",
      "Read a chronological quoted-reply thread.",
      { messageId: z.string(), limit: page.limit, cursor: z.string().optional() },
      async (args) =>
        (await deps.runtime.getIdentity()).getWhatsAppThread(args.messageId, {
          limit: args.limit,
          cursor: args.cursor,
        }),
    ],
    [
      "get_whatsapp_conversation_thread",
      "Read one conversation's quoted-reply thread.",
      {
        conversationId: z.string(),
        threadId: z.string(),
        limit: page.limit,
        cursor: z.string().optional(),
      },
      async (args) =>
        (await deps.runtime.getIdentity()).getWhatsAppConversationThread(
          args.conversationId,
          args.threadId,
          { limit: args.limit, cursor: args.cursor },
        ),
    ],
    [
      "get_whatsapp_reaction",
      "Read a reaction receipt; queued or uncertain is not applied.",
      { reactionId: z.string() },
      async (args) => (await deps.runtime.getIdentity()).getWhatsAppReaction(args.reactionId),
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
        const identity = await deps.runtime.getIdentity();
        assertWhatsAppOwner(owner);
        if (ctx.abort?.aborted) throw new Error("The originating tool was cancelled.");
        if (owner?.whatsappSource && owner.whatsappSource.identityId !== identity.id)
          throw new Error("The originating identity changed.");
        return identity.uploadWhatsAppMedia({
          content,
          filename: basename(args.mediaPath),
        });
      },
    ],
    [
      "send_whatsapp",
      "Send WhatsApp text/media to one recipient, 2–8 recipients for a group, or an existing direct/group conversation. Active-source replies inherit their conversation and quote target; explicit destinations remain authoritative. Explicit quoted replies require conversationId. Normal final answers reply automatically; do not duplicate them. Keep the original key/media ID after uncertainty.",
      {
        to: z.union([z.string(), z.array(z.string()).min(1).max(8)]).optional(),
        replyToMessageId: z.string().min(1).optional(),
        groupName: z.string().min(1).max(100).optional(),
        conversationId: z.string().optional(),
        text: z.string().optional(),
        mediaId: z.string().optional(),
        idempotencyKey: z.string().optional(),
      },
      async (args, ctx) => {
        assertWhatsAppText(args.text ?? "");
        const store = createStateStore();
        const owner = await whatsappToolOwner(ctx.sessionID, ctx, deps.opencode, store);
        const conversationId =
          args.conversationId ??
          (!args.to && owner?.channel === "whatsapp" ? owner.conversationId : undefined);
        if (Boolean(args.to) === Boolean(conversationId) || !(args.text?.trim() || args.mediaId))
          throw new Error("Use one recipient or conversation and text or one owned media ID.");
        const identity = await deps.runtime.getIdentity();
        const conversation = conversationId
          ? await identity.getWhatsAppConversation(conversationId)
          : undefined;
        if (
          args.replyToMessageId !== undefined &&
          (typeof args.replyToMessageId !== "string" || !args.replyToMessageId.trim())
        )
          throw new Error("replyToMessageId must be a nonempty message ID.");
        const explicitRecipients = args.to === undefined ? undefined : whatsappRecipients(args.to);
        if (args.replyToMessageId && !conversationId)
          throw new Error("replyToMessageId requires conversationId.");
        if (args.groupName && (!explicitRecipients || explicitRecipients.length < 2))
          throw new Error("groupName is only a group creation hint.");
        if (
          conversation &&
          (conversation.agentIdentityId !== identity.id ||
            !conversation.participants.length ||
            (conversation.unresolvedParticipantCount ?? 0) > 0 ||
            conversation.participants.some((number: string) => !/^\+[1-9]\d{6,14}$/.test(number)))
        )
          throw new Error("A resolved conversation owned by this identity is required.");
        const recipients = explicitRecipients ?? conversation?.participants ?? [];
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
          ...(args.replyToMessageId ? { replyToMessageId: args.replyToMessageId } : {}),
          ...(args.groupName ? { groupName: args.groupName } : {}),
        };
        const source = owner?.nativeOwner?.turnId ?? ctx.messageID;
        const key =
          args.idempotencyKey ??
          `opencode:whatsapp-tool:${createHash("sha256")
            .update(JSON.stringify([identity.id, source, args.to, args.conversationId, payload]))
            .digest("hex")}`;
        const recipient = explicitRecipients?.length === 1 ? explicitRecipients[0] : "";
        const sameConversation =
          owner?.channel === "whatsapp" &&
          (conversationId?.toLowerCase() === owner.conversationId?.toLowerCase() ||
            (!owner.group && /^\+[1-9]\d{6,14}$/.test(recipient) && recipient === owner.sender));
        const target = {
          ...(owner ?? {}),
          channel: "whatsapp" as const,
          to: sameConversation
            ? undefined
            : typeof args.to === "string"
              ? explicitRecipients?.[0]
              : undefined,
          whatsappRecipients:
            !sameConversation && Array.isArray(args.to) ? explicitRecipients : undefined,
          // Source ownership does not rewrite a retained request selector.
          conversationId: sameConversation
            ? (conversationId ?? owner.conversationId)
            : conversationId,
          messageId: owner?.messageId ?? ctx.messageID,
        };
        if (!sameConversation) delete target.whatsappSource;
        const message = await (
          await prepareWhatsApp(identity, target, payload, store, key, !args.idempotencyKey)
        )();
        return { message, idempotencyKey: key, mediaId: args.mediaId ?? null };
      },
    ],
  ];
  for (const remove of [false, true])
    specs.push([
      remove ? "remove_whatsapp_reaction" : "send_whatsapp_reaction",
      remove
        ? "Remove this exact reaction revision. Keep the original key after uncertainty."
        : "React with a named reaction or custom emoji. Queued or uncertain is not applied; keep the original key.",
      remove
        ? { reactionId: z.string(), idempotencyKey: z.string().min(1) }
        : {
            messageId: z.string(),
            reaction: z
              .enum(["love", "like", "dislike", "laugh", "emphasize", "question", "eyes"])
              .optional(),
            customEmoji: z
              .string()
              .min(1)
              .refine((value) => Array.from(value).length <= 32)
              .optional(),
            idempotencyKey: z.string().min(1),
          },
      async (args, ctx) => {
        // Mirror SDK preflight before recording intent; unknown SDK failures must stay fenced.
        if (
          typeof args.idempotencyKey !== "string" ||
          !args.idempotencyKey.trim() ||
          args.idempotencyKey.length > 255
        )
          throw new Error("A stable idempotencyKey is required");
        if (!remove) {
          if ((args.reaction == null) === (args.customEmoji == null))
            throw new Error("Specify reaction or customEmoji.");
          if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(args.messageId))
            throw new Error("Provide a valid messageId UUID.");
          if (
            args.reaction != null &&
            !["love", "like", "dislike", "laugh", "emphasize", "question", "eyes"].includes(
              args.reaction,
            )
          )
            throw new Error("Unsupported WhatsApp reaction");
          if (
            args.customEmoji != null &&
            (!args.customEmoji ||
              Array.from(args.customEmoji).length > 32 ||
              /[\s\p{Cc}\p{Cs}]/u.test(args.customEmoji))
          )
            throw new Error("customEmoji must contain 1–32 non-whitespace characters");
        }
        const store = createStateStore();
        const owner = await whatsappToolOwner(ctx.sessionID, ctx, deps.opencode, store);
        const identity = await deps.runtime.getIdentity();
        if (owner?.whatsappSource && owner.whatsappSource.identityId !== identity.id)
          throw new Error("The originating identity changed.");
        const receipt = remove ? await identity.getWhatsAppReaction(args.reactionId) : undefined;
        const message = await identity.getWhatsAppMessage(
          receipt?.targetMessageId ?? args.messageId,
        );
        const conversation = await identity.getWhatsAppConversation(message.conversationId);
        if (
          message.agentIdentityId !== identity.id ||
          conversation.agentIdentityId !== identity.id ||
          !conversation.participants.length ||
          (conversation.unresolvedParticipantCount ?? 0) > 0 ||
          conversation.participants.some((number: string) => !/^\+[1-9]\d{6,14}$/.test(number))
        )
          throw new Error("The reaction target must belong to a resolved owned conversation.");
        await approveOutbound(ctx, deps.config, {
          tool: remove ? "inkbox_remove_whatsapp_reaction" : "inkbox_send_whatsapp_reaction",
          recipients: conversation.participants,
          summary: "Apply the requested WhatsApp reaction operation",
        });
        assertWhatsAppOwner(owner, store);
        if (ctx.abort?.aborted) throw new Error("The originating tool was cancelled.");
        const operation = remove
          ? { remove: args.reactionId }
          : { messageId: args.messageId, reaction: args.reaction, customEmoji: args.customEmoji };
        const key = `reaction:${createHash("sha256")
          .update(JSON.stringify([identity.id, args.idempotencyKey]))
          .digest("hex")}`;
        const entry = {
          identityId: identity.id,
          idempotencyKey: args.idempotencyKey,
          operation: JSON.stringify(operation),
          state: "started",
        };
        let previous: (typeof entry & { result?: unknown }) | undefined;
        store.updateWhatsAppSend(key, (existing) => {
          previous = existing as typeof previous;
          if (previous && previous.operation !== entry.operation)
            throw new Error("The original WhatsApp reaction key belongs to a different operation.");
          return previous?.state === "accepted" ? previous : entry;
        });
        if (previous?.state === "accepted") return previous.result;
        try {
          const result = remove
            ? await identity.removeWhatsAppReaction(args.reactionId, args.idempotencyKey)
            : await identity.sendWhatsAppReaction({
                messageId: args.messageId,
                ...(args.reaction
                  ? { reaction: args.reaction }
                  : { customEmoji: args.customEmoji }),
                idempotencyKey: args.idempotencyKey,
              });
          store.updateWhatsAppSend(key, () => ({ ...entry, state: "accepted", result }));
          return result;
        } catch (error) {
          const policy = publicWhatsAppPolicy(error);
          if (policy) {
            store.updateWhatsAppSend(key, () => ({ ...entry, state: "rejected", policy }));
            throw Object.assign(new Error("WhatsApp reaction request was not accepted."), {
              whatsappPolicy: policy,
              idempotencyKey: args.idempotencyKey,
            });
          }
          throw new Error(
            `WhatsApp reaction outcome is not confirmed. Retain the exact operation and idempotencyKey=${args.idempotencyKey}; do not create another request. Queued or uncertain is not applied.`,
          );
        }
      },
    ]);
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
