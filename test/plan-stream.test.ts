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
  it.each([["subscription_sharing_usage_limit_exceeded","CODEX_USAGE_LIMIT"],["subscription_sharing_usage_unavailable","CODEX_UPSTREAM_UNAVAILABLE"]])("preserves subscription error category %s after the stream opens", async (code,expected) => {
    const error=await readPlanStream(stream([event({type:"response.failed",response:{status:"failed",error:{code,message:"private-proof private-token"}}})])).catch(e=>e);
    expect(error.code).toBe(expected);
    expect(String(error)+JSON.stringify(error)).not.toMatch(/private-proof|private-token/);
  });
  it.each(["fast","priority","default","auto"])("reports actual %s tier from terminal metadata only", async tier => {
    let metadata: unknown;
    const value = await readPlanStream(stream([completed({service_tier:tier,output:[{type:"message",content:[{type:"output_text",text:"proof"}]}]})]),{onCompleted:m=>{metadata=m;}});
    expect(value).toBe("proof");
    expect(metadata).toEqual({serviceTier:tier});
  });
  it("omits unknown provider tier metadata rather than exposing it", async () => {
    let metadata: unknown;
    await readPlanStream(stream([completed({service_tier:"private-token",output:[{type:"message",content:[{type:"output_text",text:"proof"}]}]})]),{onCompleted:m=>{metadata=m;}});
    expect(metadata).toEqual({});
  });
  it("categorizes an unsupported service tier without retaining provider text", async () => {
    const error = await readPlanStream(Response.json({error:{code:"subscription_sharing_unsupported_capability",param:"service_tier",message:"private-proof Bearer private-token"}},{status:400})).catch(e=>e);
    expect(error).toMatchObject({code:"CODEX_SPEED_UNAVAILABLE",status:400});
    expect(String(error)+JSON.stringify(error)).not.toMatch(/private-proof|private-token/);
  });
  it("keeps safe machine diagnostics for a service-tier rejection with a null code", async () => {
    const error=await readPlanStream(Response.json({error:{type:"invalid_request_error",code:null,param:"service_tier",message:"private-proof Bearer private-token"}},{status:400,headers:{"x-request-id":"req_test400"}})).catch(e=>e);
    expect(error).toMatchObject({code:"CODEX_SPEED_UNAVAILABLE",status:400,param:"service_tier",providerType:"invalid_request_error",bodyShape:"error",requestId:"req_test400"});
    expect(String(error)+JSON.stringify(error)).not.toMatch(/private-proof|private-token/);
  });
  it("distinguishes a detail-shaped admission error without interpreting its prose",async()=>{
    const error=await readPlanStream(Response.json({detail:"private-proof Bearer private-token"},{status:400,headers:{"x-request-id":"Bearer private-token"}})).catch(e=>e);
    expect(error).toMatchObject({code:"CODEX_RESPONSE_FAILED",bodyShape:"detail"});
    expect(error.requestId).toBeUndefined();
    expect(String(error)+JSON.stringify(error)).not.toMatch(/private-proof|private-token/);
  });
  it("does not expose arbitrary provider parameter or error codes",async()=>{
    const error=await readPlanStream(Response.json({error:{type:"private-type",code:"private-code",param:"private-param",message:"private-proof"}},{status:400})).catch(e=>e);
    expect(error).toMatchObject({bodyShape:"error"});
    expect(error.param).toBeUndefined();
    expect(error.providerType).toBeUndefined();
    expect(String(error)+JSON.stringify(error)).not.toMatch(/private-type|private-code|private-param|private-proof/);
  });
  it.each([["rate_limit_exceeded","CODEX_USAGE_LIMIT"],["invalid_token","CODEX_AUTH_REQUIRED"],["unsupported_model","CODEX_MODEL_UNAVAILABLE"],["server_error","CODEX_UPSTREAM_UNAVAILABLE"]])("prioritizes recognized %s failures over a service-tier parameter",async(code,expected)=>{
    const error=await readPlanStream(Response.json({error:{code,param:"service_tier"}},{status:400})).catch(e=>e);
    expect(error.code).toBe(expected);
  });
  it("bounds error-body reads and cancels oversized untrusted diagnostics", async () => {
    let cancelled=false,pulled=0;
    const body = new ReadableStream<Uint8Array>({pull(c){pulled++;c.enqueue(encoder.encode("private-token".repeat(1000)));},cancel(){cancelled=true;}});
    const error = await readPlanStream(new Response(body,{status:400})).catch(e=>e);
    expect(error.code).toBe("CODEX_RESPONSE_FAILED");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(4);
    expect(String(error)+JSON.stringify(error)).not.toContain("private-token");
  });
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
