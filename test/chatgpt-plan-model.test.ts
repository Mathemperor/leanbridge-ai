import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProofRequest } from "../src/shared/proof";
import { formatImageTranscription } from "../src/shared/proof";
import { ChatGPTPlanProofModel } from "../src/server/adapters/model/chatgpt-plan-model";

const translation = { normalizedSource: "n+0=n", theoremSummary: "Addition", assumptions: [], imports: [], leanCode: "example (n : Nat) : n + 0 = n := by rfl", notes: [] };
const transcription = { problemText: "Prove addition", problemLatex: "n+0=n", solutionText: "By reflexivity", solutionLatex: "rfl", uncertainties: ["Bottom line cropped"] };
const text: ProofRequest = { mode: "latex", latex: "Prove n+0=n", autoRepair: false };
const image: Extract<ProofRequest, { mode: "image" }> = { mode: "image", imageDataUrl: "data:image/png;base64,dGVzdC1pbWFnZQ==", context: "private context", autoRepair: false };
const session = () => ({ accessToken: async () => "oauth-private-token", catalog: async () => [{ slug: "gpt-6-astra", display_name: "Astra", visibility: "list" }, { slug: "gpt-6.1-sol", visibility: "list" }] });
const response = (value: unknown) => new Response(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify(value) })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`));

afterEach(() => vi.useRealTimers());

describe("ChatGPT plan proof model", () => {
  it.each([["fast", "priority"], ["standard", "default"], [undefined, undefined]] as const)("routes selected speed %s without changing model or effort", async (speed, tier) => {
    let payload: Record<string, unknown> = {};
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "max" }, session(), async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return response(translation);
    });
    await model.translate({ ...text, ...(speed ? { speed } : {}) });
    expect(payload).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "max" } });
    if (tier) expect(payload.service_tier).toBe(tier);
    else expect(payload).not.toHaveProperty("service_tier");
  });

  it("retains speed through image recognition, text-only generation and compiler-guided repair", async () => {
    const { ProofPipeline } = await import("../src/server/domain/proof-pipeline");
    const requests: Record<string, any>[] = [];
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, session(), async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const value = requests.length === 1 ? transcription : translation;
      return new Response(`data: ${JSON.stringify({type:"response.output_text.delta",delta:JSON.stringify(value)})}\n\ndata: ${JSON.stringify({type:"response.completed",response:{status:"completed",service_tier:requests.length===1?"priority":"fast"}})}\n\n`);
    });
    let checks = 0;
    const pipeline = new ProofPipeline({ model, verifier: { verify: async () => ({ok:++checks>1,status:checks>1?"verified":"failed",command:"test Lean",durationMs:1,output:"type mismatch",diagnostics:[]}) } });
    const job = pipeline.start({...image,autoRepair:true,speed:"fast",model:"gpt-6-astra",reasoningEffort:"high"});
    await pipeline.run(job.id);
    const result = pipeline.get(job.id)!;
    expect(result.status).toBe("verified");
    expect(requests.map(r=>r.service_tier)).toEqual(["priority","priority","priority"]);
    expect(result.modelConfig).toMatchObject({model:"gpt-6-astra",reasoningEffort:"high",speed:"fast"});
    expect(result.imageTranscription?.serviceTier).toBe("priority");
    expect(result.translation?.serviceTier).toBe("fast");
  });

  it("records a provider downgrade and never trusts a generated tier claim", async () => {
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, session(), async () => new Response(`data: ${JSON.stringify({type:"response.output_text.delta",delta:JSON.stringify({...translation,serviceTier:"fast"})})}\n\ndata: ${JSON.stringify({type:"response.completed",response:{status:"completed",service_tier:"default"}})}\n\n`));
    expect(await model.translate({...text,speed:"fast"})).toMatchObject({serviceTier:"default"});
  });

  it("isolates queued speed choices and does not silently retry unsupported Fast", async () => {
    const tiers: unknown[] = [];
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, session(), async (_url, init) => {
      tiers.push(JSON.parse(String(init?.body)).service_tier);
      return tiers.length===1 ? Response.json({error:{code:"subscription_sharing_unsupported_capability",param:"service_tier",message:"private proof"}},{status:400}) : response(translation);
    });
    const results = await Promise.allSettled([model.translate({...text,speed:"fast"}),model.translate({...text,speed:"standard"})]);
    expect(results[0]).toMatchObject({status:"rejected",reason:{code:"CODEX_SPEED_UNAVAILABLE"}});
    expect(results[1].status).toBe("fulfilled");
    expect(tiers).toEqual(["priority","default"]);
  });

  it("uses OAuth Responses with the exact selected settings and strict structured output", async () => {
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, session(), async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-private-token");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: "gpt-6.1-sol", reasoning: { effort: "ultra" }, store: false, stream: true, text: { format: { type: "json_schema", strict: true, schema: { additionalProperties: false } } } });
      expect(body.instructions).toContain("formalization engineer");
      expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Formalize this LaTeX or natural-language proof:\n\nProve n+0=n" }] }]);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("max_output_tokens");
      expect(body).not.toHaveProperty("background");
      expect(JSON.stringify(body)).not.toMatch(/oauth-private-token|"system"/);
      return response(translation);
    });
    expect(await model.translate({ ...text, model: "gpt-6.1-sol", reasoningEffort: "ultra" })).toEqual(translation);
  });

  it("sends the image once for bounded OCR, then sends only text for translation and repair", async () => {
    const requests: Record<string, any>[] = [];
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "max" }, session(), async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      return response(requests.length === 1 ? transcription : translation);
    });
    const recognized = await model.transcribeImage(image);
    const source: ProofRequest = { mode: "latex", latex: formatImageTranscription(recognized), imageTranscription: recognized, autoRepair: false };
    const candidate = await model.translate(source);
    await model.repair({ source, translation: candidate, diagnostics: "unknown constant old" });
    expect(requests).toHaveLength(3);
    const ocr = requests[0]!;
    expect(ocr.instructions).toContain("Never solve");
    expect(ocr.instructions).not.toContain("formalization engineer");
    expect(ocr.input[0].content).toEqual([{ type: "input_image", image_url: image.imageDataUrl, detail: "original" }, { type: "input_text", text: expect.stringContaining("private context") }]);
    expect(JSON.stringify(ocr).split(image.imageDataUrl)).toHaveLength(2);
    expect(ocr.text.format.schema).toMatchObject({ required: ["problemText", "problemLatex", "solutionText", "solutionLatex", "uncertainties"], properties: { problemText: { maxLength: 8000 }, solutionLatex: { maxLength: 8000 }, uncertainties: { maxItems: 20, items: { maxLength: 200 } } } });
    for (const body of requests.slice(1)) {
      expect(body.input[0].content.map((item: any) => item.type)).toEqual(["input_text"]);
      expect(JSON.stringify(body)).not.toContain("data:image");
    }
    expect(JSON.stringify(requests[2])).toContain("unknown constant old");
  });

  it("rejects direct image translation and repair before session or network access", async () => {
    let touched = false;
    const unavailable = { accessToken: async () => { touched = true; throw new Error("must not call"); }, catalog: async () => { touched = true; return []; } };
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, unavailable, async () => { touched = true; throw new Error("must not call"); });
    await expect(model.translate(image)).rejects.toThrow(/transcrib/i);
    await expect(model.repair({ source: image, translation, diagnostics: "error" })).rejects.toThrow(/transcrib/i);
    expect(touched).toBe(false);
  });

  it.each([[], [{ slug: "gpt-6-astra", visibility: "hidden" }], [{ slug: "gpt-6.1-sol", visibility: "list" }]].map(catalog => ({ catalog })))("rejects a selected model absent from the usable account catalog", async ({ catalog }) => {
    let requested = false;
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "max" }, { ...session(), catalog: async () => catalog }, async () => { requested = true; return response(translation); });
    await expect(model.translate(text)).rejects.toMatchObject({ code: "CODEX_MODEL_UNAVAILABLE" });
    expect(requested).toBe(false);
  });

  it("retains generated Lean candidates and normalizes fences for downstream validation", async () => {
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "max" }, session(), async () => response({ ...translation, leanCode: "```lean\nexample : False := by sorry\n```" }));
    expect((await model.translate(text)).leanCode).toBe("example : False := by sorry");
  });

  it.each(["not-json-private-proof", JSON.stringify({ ...translation, leanCode: 123 })])("never leaks malformed proof JSON or validation values", async output => {
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "max" }, session(), async () => new Response(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: output })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`)));
    const error = await model.translate(text).catch(error => error);
    expect(error).toMatchObject({ code: "CODEX_RESPONSE_INVALID" });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/private-proof|123|oauth-private-token/);
  });

  it("validates the OCR five-field bounds with safe errors", async () => {
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, session(), async () => response({ ...transcription, problemText: "private".repeat(2000) }));
    const error = await model.transcribeImage(image).catch(error => error);
    expect(error).toMatchObject({ code: "CODEX_TRANSCRIPTION_INVALID" });
    expect(String(error) + JSON.stringify(error)).not.toContain("private");
  });

  it("serializes OCR and formalization, then continues after a failed request", async () => {
    let active = 0, maxActive = 0, count = 0;
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, session(), async () => {
      active++; maxActive = Math.max(active, maxActive); count++;
      await new Promise(resolve => setTimeout(resolve, 10)); active--;
      if (count === 1) throw new Error("private-fetch-secret");
      return response(translation);
    });
    const results = await Promise.allSettled([model.transcribeImage(image), model.translate(text), model.repair({ source: text, translation, diagnostics: "error" })]);
    expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(maxActive).toBe(1);
    expect(JSON.stringify(results[0])).not.toContain("private-fetch-secret");
  });

  it.each([["ocr", 180_000], ["text", 900_000]] as const)("enforces the default %s deadline and cancels a stalled body", async (stage, timeout) => {
    vi.useFakeTimers(); let cancelled = false, signal: AbortSignal | null | undefined;
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, session(), async (_url, init) => {
      signal = init?.signal;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    });
    const promise = stage === "ocr" ? model.transcribeImage(image) : model.translate(text);
    const rejection = expect(promise).rejects.toMatchObject({ code: "CODEX_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("uses separately configured deadlines and sanitizes session failures", async () => {
    vi.useFakeTimers();
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high", timeoutMs: 500, transcriptionTimeoutMs: 100 }, session(), async () => new Response(new ReadableStream()));
    const ocr = model.transcribeImage(image);
    const ocrRejection = expect(ocr).rejects.toMatchObject({ code: "CODEX_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100); await ocrRejection;
    const formal = model.translate(text);
    const formalRejection = expect(formal).rejects.toMatchObject({ code: "CODEX_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(500); await formalRejection;
    const unavailable = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, { ...session(), accessToken: async () => { throw new Error("Bearer oauth-private-token private-proof"); } });
    const error = await unavailable.translate(text).catch(error => error);
    expect(String(error) + JSON.stringify(error)).not.toMatch(/oauth-private-token|private-proof/);
  });

  it.each([
    ["PLAN_TEMPORARY_FAILURE", "CODEX_UPSTREAM_UNAVAILABLE"],
    ["PLAN_CATALOG_UNAVAILABLE", "CODEX_UPSTREAM_UNAVAILABLE"],
    ["PLAN_STORAGE_UNAVAILABLE", "CODEX_UPSTREAM_UNAVAILABLE"],
    ["PLAN_RECONNECT_REQUIRED", "CODEX_AUTH_REQUIRED"],
  ])("preserves categorical session failure %s without false reconnect advice", async (message, code) => {
    const model = new ChatGPTPlanProofModel({ model: "gpt-6-astra", reasoningEffort: "high" }, { ...session(), catalog: async () => { throw new Error(message); } });
    await expect(model.translate(text)).rejects.toMatchObject({ code });
  });
});
