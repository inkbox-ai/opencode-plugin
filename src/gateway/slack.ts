import {
  ownSlackConnection,
  parseSlack,
  prepareSlackSource,
  resolveSlackAuthor,
  SlackConnectionDenied,
  type SlackRoute,
  slackControlText,
  slackRouteKey,
} from "../slack.js";
import {
  VOICE_NOTE_WAIT_MS,
  VoiceNoteNotAdmitted,
  voiceNoteContext,
  voiceNoteSourceId,
} from "../voice-notes.js";
import { companionChatKey, companionMetadata } from "./companion.js";
import type { DispatchDeps } from "./dispatch.js";
import { retryableRead } from "./sessions.js";
import type { VerifiedEvent } from "./types.js";

export function slackSenderAllowed(route: SlackRoute, config: DispatchDeps["config"]): boolean {
  const g = config.gateway;
  if (
    g.allowedInboundContactIds.length &&
    (!route.contactId || !g.allowedInboundContactIds.includes(route.contactId))
  )
    return false;
  return (
    g.allowAllUsers ||
    !g.allowedUsers.length ||
    g.allowedUsers.some((value) =>
      [route.author, route.actorId, `${route.workspaceId}:${route.actorId}`].includes(value),
    )
  );
}
// Reads made before the turn is admitted. A timeout, network failure, 408,
// 429 or 5xx leaves the message unadmitted so it can be delivered again; a
// denial and every other error stay final.
async function readBeforeAdmission<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SlackConnectionDenied || !retryableRead(error)) throw error;
    throw new VoiceNoteNotAdmitted("Slack is temporarily unavailable.", { cause: error });
  }
}
export async function dispatchSlack(deps: DispatchDeps, event: VerifiedEvent): Promise<boolean> {
  if (!deps.config.gateway.slackEnabled || !event.verified) return true;
  const identity = await readBeforeAdmission(() => deps.inkbox.getIdentity());
  const client = await readBeforeAdmission(() => deps.inkbox.getClient());
  const route = parseSlack(event.body, identity.id);
  if (!route) return true;
  const connection = await readBeforeAdmission(() =>
    ownSlackConnection(client, identity.id, route.connectionId),
  );
  route.connectionGeneration = connection.generation;
  if (connection.workspaceId !== route.workspaceId)
    throw new Error("Slack connection workspace mismatch.");
  const nativeText = slackControlText(route, connection.botUserId);
  if (event.body.companion) {
    const metadata = companionMetadata(event.body.companion);
    if (metadata.channel !== "slack") throw new Error("Slack Companion channel mismatch.");
    if (route.nativeStop) {
      await resolveSlackAuthor(
        client,
        route,
        (event.body.data as Record<string, unknown>).actor_profile,
      );
      if (!slackSenderAllowed(route, deps.config)) return true;
      if (!metadata.activation_id || !deps.sessions.stopSlack) return true;
      await deps.sessions.stopSlack(
        route,
        companionChatKey(identity.id, metadata, deps.config.baseUrl, route.connectionId),
      );
      return true;
    }
    const source = await prepareSlackSource(client, identity.id, event.body);
    if (!slackSenderAllowed(source.route, deps.config)) return true;
    const slackEvent = (event.body.data as Record<string, any>).event;
    const files = slackEvent?.files;
    // A completion is matched by the retained message ID, so wait only when
    // the envelope names the same message as the archived source.
    const waits =
      Array.isArray(files) &&
      files.some((item) => item && typeof item === "object" && "transcription" in item) &&
      voiceNoteSourceId(event.body) === source.id;
    const turn = {
      metadata,
      ...(waits
        ? {
            voiceNoteEvent: structuredClone(event.body),
            voiceNoteDeadline: Date.now() + VOICE_NOTE_WAIT_MS,
          }
        : {}),
      identityId: identity.id,
      handle: identity.agentHandle,
      sourceId: source.id,
      from: source.author,
      initialization: metadata.phase === "initialization",
      environment: deps.config.baseUrl,
      rawText: nativeText,
      senderAccess: route.senderAccess,
      slack: source.route,
    };
    if (!deps.sessions.acceptCompanion) throw new Error("Slack Companion receiver is unavailable.");
    // Without a wait, label results already present, as ordinary Slack does.
    const text = [route.text, waits ? undefined : voiceNoteContext(slackEvent)]
      .filter(Boolean)
      .join("\n\n");
    await deps.sessions.acceptCompanion(turn, `${source.author}: ${text}`, {
      channel: "slack",
      slack: source.route,
      sender: source.author,
    });
    return true;
  }
  if (!slackSenderAllowed(route, deps.config)) return true;
  if (route.nativeStop) {
    await deps.sessions.stopSlack?.(route);
    return true;
  }
  const chatKey = `slack:${encodeURIComponent(deps.config.baseUrl ?? "https://inkbox.ai")}:${slackRouteKey(route)}`;
  const engagement = deps.sessions.status(chatKey);
  // Quiet channel traffic cannot start a session, invoke controls or display
  // activity. An admitted turn counts even before its host session is created.
  if (!route.addressed && !engagement.sessionID && !engagement.busy) return true;
  await deps.sessions.handleInbound({
    channel: "slack",
    slack: route,
    chatKey,
    from: route.author,
    messageId: route.sourceEventId,
    conversationId: route.conversationId,
    text: [route.text, voiceNoteContext((event.body.data as Record<string, any>).event)]
      .filter(Boolean)
      .join("\n\n"),
    rawText: nativeText,
    mediaPaths: [],
    contactId: route.contactId,
    ...(!route.direct ? { group: { participantCount: 2 } } : {}),
  });
  return true;
}
