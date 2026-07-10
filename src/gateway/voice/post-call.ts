import { randomUUID } from "node:crypto";

// Follow-up work the model queues during a call, run as one turn after the
// call ends. Kept in memory per call; nothing persists past hangup.
export interface PostCallAction {
  id: string;
  description: string;
}

export interface PostCallRegistry {
  register(description: string): string;
  edit(id: string, description: string): boolean;
  remove(id: string): boolean;
  list(): PostCallAction[];
}

export function createPostCallRegistry(): PostCallRegistry {
  const actions = new Map<string, PostCallAction>();
  return {
    register(description) {
      const id = randomUUID();
      actions.set(id, { id, description });
      return id;
    },
    edit(id, description) {
      const a = actions.get(id);
      if (!a) return false;
      a.description = description;
      return true;
    },
    remove(id) {
      return actions.delete(id);
    },
    list() {
      return [...actions.values()];
    },
  };
}

// A prompt that runs the queued actions once the call has ended, reconciled
// against what was already handled live.
export function postCallPrompt(actions: PostCallAction[], transcript: string): string {
  const lines = [
    "The call just ended. Carry out the follow-up actions you committed to during it, using your tools.",
    "Reconcile against the transcript first — skip anything already done, and don't duplicate messages already sent.",
    "",
    "Queued actions:",
    ...actions.map((a, i) => `${i + 1}. ${a.description}`),
  ];
  if (transcript.trim()) lines.push("", "Recent call transcript:", transcript);
  return lines.join("\n");
}

// A reflection prompt when no explicit actions were queued but the call may
// still imply follow-up.
export function callEndedPrompt(transcript: string): string {
  const lines = [
    "A call you were on just ended. If it implies follow-up work, do it now with your tools.",
    "Reconcile against the transcript first: only act on what was actually promised and not already done.",
  ];
  if (transcript.trim()) lines.push("", "Recent call transcript:", transcript);
  return lines.join("\n");
}

// Two-step hangup: the model must call hang_up_call twice within the window
// to actually end the call (the first call arms it, letting the model say
// goodbye first).
export function createHangupArmer(windowMs: number, now: () => number) {
  let armedAt = 0;
  return {
    // Returns true when this call should actually end.
    press(): boolean {
      const t = now();
      if (armedAt > 0 && t - armedAt <= windowMs) {
        armedAt = 0;
        return true;
      }
      armedAt = t;
      return false;
    },
    armed(): boolean {
      return armedAt > 0;
    },
  };
}
