// Deterministic OpenAI-compatible mock for live pipe tests. opencode's
// provider config points at this server, so the agent "thinks" here — no real
// key, no tokens, no flakiness — while the rest of the pipeline (gateway,
// tunnel, sessions, delivery) stays fully real.
//
// Every reply contains REPLY_OK plus the inbound's smoke nonce (when present),
// so a live test can assert the canned content travelled end to end.
//
// Run: node mock-openai.mjs [port]   (default 8088; stdlib only)
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8088);
const NONCE = /smoke-[0-9a-f]{6,}/;

function replyText(req) {
  const m = JSON.stringify(req).match(NONCE);
  return `REPLY_OK ${m ? m[0] : "no-nonce"} — automated reachability reply from the agent.`;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

const completion = (model, text) => ({
  id: "chatcmpl-mock",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

createServer((req, res) => {
  if (req.method === "GET") {
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

    if (!body.stream) return sendJson(res, 200, completion(model, text));

    // SSE streaming: one content delta, then the stop chunk, then [DONE].
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-mock",
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
