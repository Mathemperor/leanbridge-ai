import { describe, expect, it } from "vitest";
import { readPlanStream } from "../src/server/adapters/model/plan-stream";

const encoder = new TextEncoder();
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const completed = (response: Record<string, unknown> = {}) => event({ type: "response.completed", response: { status: "completed", ...response } });

function stream(parts: string[], cancel?: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); controller.close(); },
    cancel() { cancel?.(); },
  }));
}

describe("ChatGPT plan response stream", () => {
  it("accepts a headerless stream with delta-only terminal completion", async () => {
    const response = stream([
      event({ type: "response.output_text.delta", delta: '{"leanCode":' }),
      event({ type: "response.output_text.delta", delta: '"rfl"}' }), completed(),
    ]);
    expect(response.headers.get("content-type")).toBeNull();
    expect(await readPlanStream(response)).toBe('{"leanCode":"rfl"}');
  });

  it("uses complete terminal message text in place of partial deltas", async () => {
    expect(await readPlanStream(stream([
      event({ type: "response.output_text.delta", delta: "partial" }),
      completed({ output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"complete":true}' }] }] }),
    ]))).toBe('{"complete":true}');
  });

  it("parses split UTF-8 bytes, CRLF frames and event-name-only types", async () => {
    const bytes = encoder.encode(': heartbeat\r\nevent: response.output_text.delta\r\ndata: {"delta":"数学"}\r\n\r\nevent: response.completed\r\ndata: {"response":{"status":"completed"}}\r\n\r\n');
    const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
    expect(await readPlanStream(response)).toBe("数学");
  });

  it.each([
    [event({ type: "response.output_text.delta", delta: "partial-private-proof" }), "CODEX_STREAM_INCOMPLETE"],
    [event({ type: "response.completed", response: { status: "incomplete" } }), "CODEX_RESPONSE_INCOMPLETE"],
    [event({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }), "CODEX_RESPONSE_INCOMPLETE"],
    [event({ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "private-proof Bearer private-token" } } }), "CODEX_UPSTREAM_UNAVAILABLE"],
    ['data: {"private-proof":\n\n', "CODEX_STREAM_INVALID"],
    ['data: [DONE]\n\n', "CODEX_STREAM_INCOMPLETE"],
    [completed(), "CODEX_RESPONSE_INVALID"],
  ])("rejects incomplete, failed or malformed frames safely", async (body, code) => {
    const error = await readPlanStream(stream([body])).catch(error => error);
    expect(error).toMatchObject({ code });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/private-proof|private-token|max_output_tokens/);
  });

  it("rejects over 2 MiB even when excess bytes are SSE comments", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(`:${"x".repeat(2 * 1024 * 1024)}\n\n`)); },
      cancel() { cancelled = true; },
    }));
    await expect(readPlanStream(response)).rejects.toMatchObject({ code: "CODEX_OUTPUT_LIMIT" });
    expect(cancelled).toBe(true);
  });

  it("cancels a pending read when aborted and never reports partial text", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(streamController) { streamController.enqueue(encoder.encode(event({ type: "response.output_text.delta", delta: "private" }))); },
      cancel() { cancelled = true; },
    }));
    const result = readPlanStream(response, { signal: controller.signal });
    controller.abort("Bearer private-token");
    await expect(result).rejects.toMatchObject({ code: "CODEX_TIMEOUT" });
    expect(cancelled).toBe(true);
  });

  it("maps HTTP status without retaining a raw error body", async () => {
    const error = await readPlanStream(new Response("private-proof Bearer private-token", { status: 429 })).catch(error => error);
    expect(error).toMatchObject({ status: 429, code: "CODEX_USAGE_LIMIT" });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/private-proof|private-token/);
  });

  it("keeps only recognized provider error codes", async () => {
    const recognized = await readPlanStream(stream([event({ type: "error", code: "rate_limit_exceeded", message: "private" })])).catch(error => error);
    expect(recognized).toMatchObject({ code: "CODEX_USAGE_LIMIT", type: "rate_limit_exceeded" });
    const unknown = await readPlanStream(stream([event({ type: "error", code: "private-token", message: "private-proof" })])).catch(error => error);
    expect(String(unknown) + JSON.stringify(unknown)).not.toMatch(/private-token|private-proof/);
  });
});
