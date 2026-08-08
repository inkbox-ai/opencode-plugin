export interface PairableCall {
  id: string;
  direction?: string;
  status?: string;
  remotePhoneNumber?: string | null;
  createdAt?: Date | string | null;
  created_at?: Date | string | null;
}

function createdAt(call: PairableCall): number | undefined {
  const value = call.createdAt ?? call.created_at;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function describe(calls: PairableCall[]) {
  return {
    count: calls.length,
    directions: calls.map((call) => call.direction ?? "unknown"),
    statuses: calls.map((call) => call.status ?? "unknown"),
    timestampsPresent: calls.map((call) => createdAt(call) !== undefined),
  };
}

/** Select a call pair only when ownership is unambiguous after duplicate grace. */
export function requireExactCallPair<TDriver extends PairableCall, TAut extends PairableCall>(
  driverCalls: TDriver[],
  autCalls: TAut[],
  options: { scenarioStartedAt: number; maxCreationSkewMs: number },
): { driver: TDriver; aut: TAut } {
  const diagnostics = JSON.stringify({
    scenarioStartedAt: options.scenarioStartedAt,
    driver: describe(driverCalls),
    aut: describe(autCalls),
  });
  if (driverCalls.length !== 1 || autCalls.length !== 1) {
    throw new Error(`expected exactly one driver leg and one AUT leg; ${diagnostics}`);
  }
  const driverCreatedAt = createdAt(driverCalls[0]);
  const autCreatedAt = createdAt(autCalls[0]);
  if (driverCreatedAt === undefined || autCreatedAt === undefined) {
    throw new Error(`paired call is missing a creation timestamp; ${diagnostics}`);
  }
  if (
    driverCreatedAt < options.scenarioStartedAt ||
    autCreatedAt < options.scenarioStartedAt ||
    Math.abs(driverCreatedAt - autCreatedAt) > options.maxCreationSkewMs
  ) {
    throw new Error(`paired call timestamps do not belong to this scenario; ${diagnostics}`);
  }
  return { driver: driverCalls[0], aut: autCalls[0] };
}
