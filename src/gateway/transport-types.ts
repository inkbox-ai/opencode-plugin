// Minimal structural aliases so transport.ts doesn't import the full state /
// logger modules (keeps the tunnel-facing surface small and testable).
export interface GatewayLogger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export interface StateStoreLike {
  update(patch: Record<string, unknown>): unknown;
}
