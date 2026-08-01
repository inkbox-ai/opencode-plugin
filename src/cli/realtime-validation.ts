import WebSocket from "ws";

export interface RealtimeValidationResult {
  ok: boolean;
  detail: string;
}

export interface RealtimeValidationSocket {
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}

export type RealtimeSocketFactory = (
  url: string,
  options: { headers: Record<string, string>; handshakeTimeout: number },
) => RealtimeValidationSocket;

export interface RealtimeValidationOptions {
  timeoutMs?: number;
  socketFactory?: RealtimeSocketFactory;
}

const DEFAULT_TIMEOUT_MS = 12_000;

function safeDetail(value: unknown, apiKey: string): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replaceAll(apiKey, "***").slice(0, 500);
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  return String(value);
}

/** Prove that a key can establish and update a real OpenAI Realtime session. */
export async function validateOpenAIRealtime(
  apiKey: string,
  model: string,
  options: RealtimeValidationOptions = {},
): Promise<RealtimeValidationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketFactory: RealtimeSocketFactory =
    options.socketFactory ??
    ((url, socketOptions) => new WebSocket(url, socketOptions) as RealtimeValidationSocket);
  const url = `wss://api.openai.com/v1/realtime?${new URLSearchParams({ model })}`;

  return await new Promise((resolve) => {
    let settled = false;
    let socket: RealtimeValidationSocket | undefined;
    const finish = (result: RealtimeValidationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        socket?.terminate?.();
      }
      resolve({ ...result, detail: safeDetail(result.detail, apiKey) });
    };
    const timer = setTimeout(
      () =>
        finish({ ok: false, detail: "Timed out waiting for an OpenAI Realtime session response." }),
      timeoutMs,
    );

    try {
      socket = socketFactory(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        handshakeTimeout: timeoutMs,
      });
      socket.on("open", () => {
        try {
          socket?.send(
            JSON.stringify({
              type: "session.update",
              session: { type: "realtime", model, output_modalities: ["audio"] },
            }),
          );
        } catch (error) {
          finish({ ok: false, detail: safeDetail(error, apiKey) });
        }
      });
      socket.on("message", (data) => {
        let event: any;
        try {
          event = JSON.parse(messageText(data));
        } catch {
          return;
        }
        if (event?.type === "session.updated") {
          finish({ ok: true, detail: "OpenAI Realtime session update succeeded." });
          return;
        }
        if (event?.type === "error") {
          const error = event.error && typeof event.error === "object" ? event.error : event;
          const code = typeof error.code === "string" && error.code ? `${error.code}: ` : "";
          finish({
            ok: false,
            detail: `${code}${error.message ?? "OpenAI Realtime rejected the session."}`,
          });
        }
      });
      socket.on("error", (error) => finish({ ok: false, detail: safeDetail(error, apiKey) }));
      socket.on("close", (code, reason) => {
        finish({
          ok: false,
          detail: `OpenAI Realtime websocket closed before validation (code ${code}${reason.length ? `: ${reason.toString("utf8")}` : ""}).`,
        });
      });
    } catch (error) {
      finish({ ok: false, detail: safeDetail(error, apiKey) });
    }
  });
}
