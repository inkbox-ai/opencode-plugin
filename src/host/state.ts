import type { StateStore } from "../gateway/state.js";

export function bindHostState(state: StateStore, protocol: 1 | 2, binding?: string): void {
  const data = state.read();
  const changed =
    (data.hostProtocol ?? 1) !== protocol ||
    (data.hostBinding !== undefined && data.hostBinding !== binding);
  if (changed) {
    if (
      Object.values(data.turns).some(
        (turn) =>
          turn.sessionID &&
          ([
            "hydrating",
            "queued",
            "submitting",
            "submitted",
            "paused",
            "delivery_started",
          ].includes(turn.state) ||
            (turn.state === "completed" && turn.deliver) ||
            (turn.state === "failed" &&
              turn.uncertainStage === "submission" &&
              !turn.executionFenced)),
      )
    )
      throw new Error(
        "Existing gateway work belongs to another OpenCode host. Finish or reconcile it with that host before switching.",
      );
    state.update({
      previousHostSessions: data.sessions,
      sessions: {},
      hostProtocol: protocol,
      hostBinding: binding,
    });
  } else state.update({ hostProtocol: protocol, hostBinding: binding });
}
