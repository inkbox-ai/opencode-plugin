import {
  ownSlackConnection,
  parseSlack,
  prepareSlackSource,
  type SlackRoute,
  slackControlText,
  slackRouteKey,
} from "../slack.js";
import { companionChatKey, companionMetadata } from "./companion.js";
import type { DispatchDeps } from "./dispatch.js";
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
      [route.actorId, `${route.workspaceId}:${route.actorId}`].includes(value),
    )
  );
}
export async function dispatchSlack(deps: DispatchDeps, event: VerifiedEvent): Promise<boolean> {
  if (!deps.config.gateway.slackEnabled || !event.verified) return true;
  const identity = await deps.inkbox.getIdentity();
  const client = await deps.inkbox.getClient();
  const route = parseSlack(event.body, identity.id);
  if (!route) return true;
  const connection = await ownSlackConnection(client, identity.id, route.connectionId);
  if (connection.workspaceId !== route.workspaceId)
    throw new Error("Slack connection workspace mismatch.");
  if (!slackSenderAllowed(route, deps.config)) return true;
  const nativeText = slackControlText(route, connection.botUserId);
  if (event.body.companion) {
    const metadata = companionMetadata(event.body.companion);
    if (metadata.channel !== "slack") throw new Error("Slack Companion channel mismatch.");
    if (route.nativeStop) {
      if (!metadata.activation_id || !deps.sessions.stopSlack) return true;
      await deps.sessions.stopSlack(
        route,
        companionChatKey(identity.id, metadata, deps.config.baseUrl, route.connectionId),
      );
      return true;
    }
    const source = await prepareSlackSource(client, identity.id, event.body);
    const turn = {
      metadata,
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
    await deps.sessions.acceptCompanion(turn, `${source.author}: ${route.text}`, {
      channel: "slack",
      slack: source.route,
      sender: source.author,
    });
    return true;
  }
  if (route.nativeStop) {
    await deps.sessions.stopSlack?.(route);
    return true;
  }
  await deps.sessions.handleInbound({
    channel: "slack",
    slack: route,
    chatKey: `slack:${encodeURIComponent(deps.config.baseUrl ?? "https://inkbox.ai")}:${slackRouteKey(route)}`,
    from: route.author,
    messageId: route.sourceEventId,
    conversationId: route.conversationId,
    text: route.text,
    rawText: nativeText,
    mediaPaths: [],
    contactId: route.contactId,
    ...(!route.direct ? { group: { participantCount: 2 } } : {}),
  });
  return true;
}
