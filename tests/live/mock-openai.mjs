// Deterministic OpenAI-compatible mock for live pipe tests. opencode's
// provider config points at this server, so the agent "thinks" here — no real
// key, no tokens, no flakiness — while the rest of the pipeline (gateway,
// tunnel, sessions, delivery) stays fully real.
//
// Every reply contains REPLY_OK plus the inbound's smoke nonce (when present),
// so a live test can assert the canned content travelled end to end.
//
// Run: node mock-openai.mjs [port]   (default 8088; stdlib only)

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8088);
const NONCE = /smoke-[0-9a-f]{6,}/g;
let stopStreamsStarted = 0;
let fixtureRequest = {};

function replyText(req) {
  const nonce = JSON.stringify(req).match(NONCE)?.at(-1);
  return `REPLY_OK ${nonce ?? "no-nonce"} — automated reachability reply from the agent.`;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

const completion = (id, model, text) => ({
  id,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

createServer((req, res) => {
  if (req.method === "GET") {
    if (req.url === "/fixture-state")
      return sendJson(res, 200, { stopStreamsStarted, fixtureRequest });
    if ((req.url ?? "").replace(/\/$/, "").endsWith("/models")) {
      return sendJson(res, 200, {
        object: "list",
        data: [{ id: "mock-model", object: "model", owned_by: "mock" }],
      });
    }
    return sendJson(res, 200, { ok: true });
  }

  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* tolerate */
    }
    const model = body.model ?? "mock-model";
    const text = replyText(body);
    const id = `chatcmpl-${randomUUID()}`;

    const lastUser = body.messages?.findLastIndex((message) => message.role === "user") ?? -1;
    const input = JSON.stringify(body.messages?.[lastUser] ?? "");
    fixtureRequest = {
      stop: input.includes("SLACK_STOP_FIXTURE"),
      followup: input.includes("smoke-aabbcc55"),
      upload: input.includes("SLACK_UPLOAD_FIXTURE"),
      roles: body.messages?.map((message) => message.role),
    };
    if (input.includes("SLACK_STOP_FIXTURE") && !input.includes("smoke-aabbcc55")) {
      // Held synthetic generation proves actual host Stop releases a later source.
      stopStreamsStarted += 1;
      // Start a real SSE generation before holding it. Holding HTTP headers tests
      // provider connection startup rather than cancellation of an accepted run.
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const emit = (delta, finish_reason = null) =>
          res.write(
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        emit({ role: "assistant", content: "Working on the synthetic fixture." });
        const timer = setTimeout(() => {
          emit({}, "stop");
          res.end("data: [DONE]\n\n");
        }, 30000);
        res.on("close", () => clearTimeout(timer));
      } else {
        const timer = setTimeout(() => sendJson(res, 200, completion(id, model, text)), 30000);
        res.on("close", () => clearTimeout(timer));
      }
      return;
    }
    if (
      input.includes("SLACK_UPLOAD_FIXTURE") &&
      !input.includes("SLACK_STOP_FIXTURE") &&
      !input.includes("smoke-aabbcc55") &&
      !body.messages.slice(lastUser + 1).some((message) => message.role === "tool")
    ) {
      const call = {
        id: "call_slack_fixture",
        type: "function",
        function: {
          name: "inkbox_slack_upload_file",
          arguments: JSON.stringify({
            connectionId: "connection",
            conversationId: "CROOM",
            filePath: "chart.png",
            idempotencyKey: "native-fixture",
          }),
        },
      };
      if (!body.stream)
        return sendJson(res, 200, {
          ...completion(id, model, ""),
          choices: [
            {
              index: 0,
              message: { role: "assistant", tool_calls: [call] },
              finish_reason: "tool_calls",
            },
          ],
        });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      emit({ role: "assistant", tool_calls: [{ index: 0, ...call }] });
      emit({}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    if (!body.stream) return sendJson(res, 200, completion(id, model, text));

    // SSE streaming: one content delta, then the stop chunk, then [DONE].
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    res.write(chunk({ role: "assistant", content: text }));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`mock openai listening on 127.0.0.1:${PORT}`);
});
