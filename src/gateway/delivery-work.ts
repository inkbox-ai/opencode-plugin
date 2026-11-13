import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getHostedCall } from "./hosted-call-registry.js";
import type { DurableTurn, StateStore } from "./state.js";

type Receipt = {
  turns: string[];
  routed: boolean;
  failed?: boolean;
  outstanding?: number;
  epoch?: string;
  completed?: boolean;
  hostedCall?: { identityId: string; callId: string };
};
export type DeliveryState = "absent" | "pending" | "completed" | "failed" | "uncertain";

export class DeliveryWork {
  private readonly epoch = randomUUID();
  private readonly source = new AsyncLocalStorage<string[]>();
  private readonly active = new Set<string>();
  readonly state: StateStore;
  constructor(private readonly base: StateStore) {
    const note = (turn: DurableTurn | undefined) => {
      if (turn) this.note(turn.id);
      return turn;
    };
    this.state = {
      ...base,
      saveTurn: (turn) => {
        base.saveTurn(turn);
        note(turn);
      },
      reserveTurns: (turns) => {
        const result = base.reserveTurns(turns);
        result.forEach(note);
        return result;
      },
      reserveWhatsAppTurn: (turn) => {
        const result = base.reserveWhatsAppTurn(turn);
        if (result) note(turn);
        return result;
      },
      updateTurn: (id, patch) => note(base.updateTurn(id, patch)),
      transitionTurn: (id, expected, patch, owner) =>
        note(base.transitionTurn(id, expected, patch, owner)),
    };
  }
  private receipts(): Record<string, Receipt> {
    const value = this.base.read().deliveryWork;
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid delivery ownership records.");
    return value as Record<string, Receipt>;
  }
  private note(id: string): void {
    const sources = this.source.getStore();
    if (!sources) return;
    const records = this.receipts();
    for (const source of sources) {
      const receipt = records[source];
      if (!receipt || receipt.turns.includes(id)) continue;
      if (receipt.turns.length >= 128) throw new Error("Delivery work capacity exceeded.");
      receipt.turns.push(id);
    }
    this.base.update({ deliveryWork: records });
  }
  capture(): (task: () => Promise<void>) => Promise<void> {
    const sources = this.source.getStore() ?? [];
    if (!sources.length) return (task) => task();
    const records = this.receipts();
    for (const id of sources) {
      records[id]!.outstanding = (records[id]!.outstanding ?? 0) + 1;
      records[id]!.epoch = this.epoch;
    }
    this.base.update({ deliveryWork: records });
    let consumed = false;
    return async (task) => {
      if (consumed) throw new Error("Delivery work was already consumed.");
      consumed = true;
      const scope = [...new Set([...(this.source.getStore() ?? []), ...sources])];
      let failed = true;
      try {
        await this.source.run(scope, task);
        failed = false;
      } finally {
        const current = this.receipts();
        for (const id of sources) {
          current[id]!.outstanding = Math.max(0, (current[id]!.outstanding ?? 0) - 1);
          if (failed) current[id]!.failed = true;
        }
        this.base.update({ deliveryWork: current });
      }
    };
  }
  track(task: () => Promise<void>): Promise<void> {
    return this.capture()(task);
  }
  async dispatch(
    id: string,
    route: () => Promise<boolean | undefined>,
    hostedCall?: Receipt["hostedCall"],
  ): Promise<DeliveryState> {
    if (!id || id.length > 256) throw new Error("A bounded delivery identity is required.");
    const records = this.receipts();
    if (records[id]) return this.status(id);
    if (Object.keys(records).length >= 20000) throw new Error("Delivery receipt capacity reached.");
    records[id] = { turns: [], routed: false, ...(hostedCall ? { hostedCall } : {}) };
    this.base.update({ deliveryWork: records });
    this.active.add(id);
    try {
      await this.source.run([id], async () => {
        if ((await route()) === false) throw new Error("Delivery routing failed.");
      });
      const current = this.receipts();
      current[id]!.routed = true;
      this.base.update({ deliveryWork: current });
    } catch {
      const current = this.receipts();
      current[id]!.failed = true;
      this.base.update({ deliveryWork: current });
      throw new Error("Delivery routing did not settle.");
    } finally {
      this.active.delete(id);
    }
    return this.status(id);
  }
  status(id: string): DeliveryState {
    const snapshot = this.base.read();
    const records = snapshot.deliveryWork as Record<string, Receipt> | undefined;
    const receipt = records?.[id];
    const state = this.stateOf(id, receipt, snapshot.turns);
    if (state === "completed" && receipt && !receipt.completed) {
      receipt.completed = true;
      this.base.update({ deliveryWork: records });
    }
    return state;
  }
  private stateOf(
    id: string,
    receipt: Receipt | undefined,
    turns: Record<string, DurableTurn>,
  ): DeliveryState {
    if (!receipt) return "absent";
    if (receipt.completed) return "completed";
    if (this.active.has(id)) return "pending";
    if (receipt.failed || !receipt.routed) return "uncertain";
    if ((receipt.outstanding ?? 0) > 0 && receipt.epoch !== this.epoch) return "uncertain";
    let pending = (receipt.outstanding ?? 0) > 0;
    if (receipt.hostedCall) {
      const call = getHostedCall(receipt.hostedCall.identityId, receipt.hostedCall.callId);
      if (!call) return "uncertain";
      if (call.state === "failed") return "failed";
      if (call.state !== "completed") pending = true;
    }
    for (const id of receipt.turns) {
      const turn = turns[id];
      if (!turn || turn.uncertainStage) return "uncertain";
      if (turn.state === "failed") return "failed";
      if (
        !["delivered", "interrupted", "context_only"].includes(turn.state) &&
        !(turn.state === "completed" && !turn.deliver)
      )
        pending = true;
    }
    return pending ? "pending" : "completed";
  }
  activity(): { pending: number; uncertain: number } {
    let pending = 0,
      uncertain = 0;
    const snapshot = this.base.read();
    let changed = false;
    for (const [id, receipt] of Object.entries(
      (snapshot.deliveryWork ?? {}) as Record<string, Receipt>,
    )) {
      const status = this.stateOf(id, receipt, snapshot.turns);
      if (status === "completed" && !receipt.completed) {
        receipt.completed = true;
        changed = true;
      }
      if (status === "pending") pending++;
      if (status === "uncertain" || status === "failed") uncertain++;
    }
    if (changed) this.base.update({ deliveryWork: snapshot.deliveryWork });
    return { pending, uncertain };
  }
}
