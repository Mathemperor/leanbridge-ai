import { describe, expect, it } from "vitest";
import type { ImageTranscription, ProofJob, ProofRequest, Translation, VerificationResult } from "@shared/proof";
import type { LeanVerifier, ProofModel, RepairContext, VerifyOptions } from "./ports";
import { InMemoryJobStore } from "./job-store";
import { ProofPipeline } from "./proof-pipeline";

const source: ProofRequest = {
  mode: "latex",
  latex: "Prove that n = n.",
  projectPath: "/tmp/mathlib",
  autoRepair: true,
};

const initial: Translation = {
  normalizedSource: "For every n, n equals n.",
  theoremSummary: "Reflexivity",
  assumptions: ["n : Nat"],
  imports: ["Mathlib"],
  leanCode: "import Mathlib\ntheorem reflNat (n : Nat) : n = n := by exact broken",
  notes: [],
};

const repaired: Translation = {
  ...initial,
  leanCode: "import Mathlib\ntheorem reflNat (n : Nat) : n = n := by rfl",
  notes: ["Replaced the unknown proof term with reflexivity."],
};

const failed: VerificationResult = {
  ok: false,
  status: "failed",
  command: "lake env lean Main.lean",
  durationMs: 10,
  output: "Main.lean:2:50: error: unknown identifier 'broken'",
  diagnostics: [{ severity: "error", line: 2, column: 50, message: "unknown identifier 'broken'" }],
  exitCode: 1,
};

const verified: VerificationResult = {
  ok: true,
  status: "verified",
  command: "lake env lean Main.lean",
  durationMs: 8,
  output: "Lean verification succeeded.",
  diagnostics: [],
  exitCode: 0,
};

class FakeModel implements ProofModel {
  repairs: RepairContext[] = [];
  failure?: unknown;

  async translate(): Promise<Translation> {
    if (this.failure) throw this.failure;
    return initial;
  }

  async repair(context: RepairContext): Promise<Translation> {
    this.repairs.push(context);
    return repaired;
  }
}

class QueueVerifier implements LeanVerifier {
  readonly calls: Array<{ code: string; options: VerifyOptions }> = [];

  constructor(private readonly results: VerificationResult[]) {}

  async verify(code: string, options: VerifyOptions): Promise<VerificationResult> {
    this.calls.push({ code, options });
    return this.results.shift() ?? failed;
  }
}

function harness(results: VerificationResult[], maxRepairAttempts = 3) {
  const store = new InMemoryJobStore();
  const model = new FakeModel();
  const verifier = new QueueVerifier(results);
  const pipeline = new ProofPipeline({
    model,
    verifier,
    store,
    maxRepairAttempts,
    verifyDefaults: { timeoutMs: 1_234 },
  });
  return { store, model, verifier, pipeline };
}

describe("ProofPipeline", () => {
  const imageSource: Extract<ProofRequest,{mode:"image"}> = {mode:"image",imageDataUrl:"data:image/png;base64,dGVzdA==",context:"Use real numbers",autoRepair:true,model:"gpt-6.1-sol",reasoningEffort:"medium"};
  const recognized: ImageTranscription = {problemText:"Show x squared is nonnegative",problemLatex:"x^2\\ge 0",solutionText:"Use positivity",solutionLatex:"x\\cdot x\\ge 0",uncertainties:["Last step is cropped"]};

  it("saves recognition and releases image before text generation; repairs use the original recognized source", async () => {
    const store=new InMemoryJobStore(); const verifier=new QueueVerifier([failed,verified]);
    const calls:ProofRequest[]=[];const repairs:RepairContext[]=[]; let id="";
    const model:ProofModel={
      transcribeImage:async request=>{
        expect(request.imageDataUrl).toBe(imageSource.imageDataUrl);
        expect(store.get(id)?.status).toBe("reading");
        return recognized;
      },
      translate:async request=>{
        expect(store.getStored(id)?.request).toMatchObject({imageDataUrl:"data:image/png;base64,"});
        expect(store.get(id)).toMatchObject({status:"translating",imageTranscription:{...recognized,source:"codex",modelConfig:{model:"gpt-6.1-sol",reasoningEffort:"medium"}}});
        calls.push(request); return {...initial,normalizedSource:"model abbreviated source"};
      },
      repair:async context=>{repairs.push(context);return repaired;},
    };
    const pipeline=new ProofPipeline({model,store,verifier}); id=pipeline.start(imageSource).id;
    await pipeline.run(id);
    expect(pipeline.get(id)?.status).toBe("verified");
    expect(pipeline.get(id)?.imageTranscription?.context).toBe("Use real numbers");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({mode:"latex",autoRepair:true,model:"gpt-6.1-sol",reasoningEffort:"medium"});
    expect(calls[0]).not.toHaveProperty("imageDataUrl");
    const text=calls[0]?.mode==="latex"?calls[0].latex:"";
    for(const value of [recognized.problemText,recognized.problemLatex,recognized.solutionText,recognized.solutionLatex,recognized.uncertainties[0]!,"Use real numbers"]) expect(text).toContain(value);
    expect(repairs[0]?.source).toEqual(calls[0]);
    expect(pipeline.get(id)?.events.map(e=>e.status)).toEqual(["queued","reading","translating","verifying","repairing","verifying","verified"]);
    expect(JSON.stringify(pipeline.get(id))).not.toContain("dGVzdA==");
  });

  it("retains an empty problem recognition and stops before formalization or compilation", async () => {
    const empty={...recognized,problemText:"  ",problemLatex:""};const calls:string[]=[];
    const store=new InMemoryJobStore();
    const model:ProofModel={transcribeImage:async()=>empty,translate:async()=>{calls.push("translate");return initial;},repair:async()=>repaired};
    const verifier=new QueueVerifier([verified]);const pipeline=new ProofPipeline({model,store,verifier});const job=pipeline.start(imageSource);
    await pipeline.run(job.id);
    expect(pipeline.get(job.id)).toMatchObject({status:"failed",imageTranscription:{...empty,source:"codex"},error:expect.stringMatching(/recognition/i)});
    expect(calls).toEqual([]);expect(verifier.calls).toEqual([]);
    expect(pipeline.get(job.id)?.events.map(e=>e.status)).toEqual(["queued","reading","failed"]);
    expect(JSON.stringify(store.getStored(job.id))).not.toContain("dGVzdA==");
  });

  it.each(["unsupported","error"])("never falls back to direct image generation when recognition is %s", async kind=>{
    const calls:string[]=[];const store=new InMemoryJobStore();
    const model:ProofModel={translate:async()=>{calls.push("translate");return initial;},repair:async()=>repaired,
      ...(kind==="error"?{transcribeImage:async()=>{throw new Error("image error");}}:{})};
    const verifier=new QueueVerifier([verified]);const pipeline=new ProofPipeline({model,store,verifier});const job=pipeline.start(imageSource);
    await pipeline.run(job.id);
    expect(pipeline.get(job.id)).toMatchObject({status:"failed",error:expect.stringMatching(/recognition/i)});
    expect(calls).toEqual([]);expect(verifier.calls).toEqual([]);
    expect(JSON.stringify(store.getStored(job.id))).not.toContain("dGVzdA==");
  });

  it.each(["model","verifier"])("retains a partial transcription with blank solution after a later %s error", async phase=>{
    const partial={...recognized,solutionText:"",solutionLatex:""};
    const model:ProofModel={transcribeImage:async()=>partial,translate:async()=>{if(phase==="model")throw new Error("generation failed");return initial;},repair:async()=>repaired};
    const pipeline=new ProofPipeline({model,verifier:{verify:async()=>{throw new Error("compiler unavailable");}}});const job=pipeline.start(imageSource);
    await pipeline.run(job.id);
    expect(pipeline.get(job.id)).toMatchObject({status:"failed",imageTranscription:{...partial,source:"codex"},error:expect.stringMatching(phase==="model"?/translation/i:/verification/i)});
    expect(pipeline.get(job.id)?.events.map(e=>e.status)).toContain("translating");
  });

  it("preserves edited retry metadata on a new text job without rereading an image or trusting client provenance", async()=>{
    const original={...recognized,context:"Assume x is real",source:"codex",createdAt:"forged",modelConfig:{model:"forged",reasoningEffort:"high"}};
    const requests:ProofRequest[]=[];const model:ProofModel={transcribeImage:async()=>{throw new Error("must not reread");},translate:async request=>{requests.push(request);return initial;},repair:async()=>repaired};
    const pipeline=new ProofPipeline({model,verifier:new QueueVerifier([verified])});
    const job=pipeline.start({...source,latex:"Edited question and solution",imageTranscription:original,model:"gpt-6.1-sol",reasoningEffort:"medium"});
    expect(job.imageTranscription).toMatchObject({...recognized,context:"Assume x is real",source:"edited",modelConfig:{model:"gpt-6.1-sol",reasoningEffort:"medium"}});
    expect(job.imageTranscription?.createdAt).not.toBe("forged");
    await pipeline.run(job.id);
    expect(pipeline.get(job.id)?.status).toBe("verified");
    expect(requests[0]).toMatchObject({mode:"latex"});
    const text=requests[0]?.mode==="latex"?requests[0].latex:"";
    for(const value of [recognized.problemText,recognized.problemLatex,recognized.solutionText,recognized.solutionLatex,"Assume x is real"]) expect(text).toContain(value);
    expect(text).not.toContain("Edited question and solution");
    expect(pipeline.get(job.id)?.events.map(e=>e.status)).not.toContain("reading");
  });
  it.each([
    {problemText:"",problemLatex:" "},
    {problemText:" \n ",problemLatex:"\t"},
  ])("retains empty edited recognition and context without formalization or compilation: %j",async problem=>{
    const calls:string[]=[];
    const model:ProofModel={
      translate:async()=>{calls.push("translate");return initial;},
      repair:async()=>{calls.push("repair");return repaired;},
    };
    const verifier=new QueueVerifier([verified]);
    const pipeline=new ProofPipeline({model,verifier});
    const metadata={...problem,solutionText:"",solutionLatex:"",uncertainties:[],context:"Assume x is real"};
    const job=pipeline.start({...source,latex:"stale nonempty question",imageTranscription:metadata});
    await pipeline.run(job.id);
    expect(pipeline.get(job.id)).toMatchObject({
      status:"failed",imageTranscription:{...metadata,source:"edited"},error:expect.stringMatching(/recognition/i),
    });
    expect(calls).toEqual([]);
    expect(verifier.calls).toEqual([]);
    expect(pipeline.get(job.id)?.events.map(e=>e.status)).toEqual(["queued","failed"]);
  });
  it("retries a JSON archived image transcription using preserved assumptions and current edits instead of stale text",async()=>{
    const requests:ProofRequest[]=[];
    const model:ProofModel={transcribeImage:async()=>recognized,translate:async request=>{requests.push(request);return initial;},repair:async()=>repaired};
    const pipeline=new ProofPipeline({model,verifier:new QueueVerifier([verified])});
    const original=pipeline.start({...imageSource,context:"Let x be a real number greater than zero"});
    await pipeline.run(original.id);
    const archived=JSON.parse(JSON.stringify(pipeline.get(original.id))) as ProofJob;
    expect(archived.imageTranscription?.context).toBe("Let x be a real number greater than zero");
    const metadata={...archived.imageTranscription!,problemText:"Show x squared is positive"};
    const retryModel:ProofModel={transcribeImage:async()=>{throw new Error("must not reread");},translate:model.translate,repair:model.repair};
    const reopened=new ProofPipeline({model:retryModel,verifier:new QueueVerifier([failed,verified]),maxRepairAttempts:1});
    const retry=reopened.start({...source,latex:"stale source without assumptions",imageTranscription:metadata});
    await reopened.run(retry.id);
    expect(reopened.get(retry.id)).toMatchObject({status:"verified",imageTranscription:{context:"Let x be a real number greater than zero",problemText:"Show x squared is positive",source:"edited"}});
    const supplied=requests[1];
    expect(supplied?.mode).toBe("latex");
    const text=supplied?.mode==="latex"?supplied.latex:"";
    expect(text).toContain("Show x squared is positive");
    expect(text).toContain("Let x be a real number greater than zero");
    expect(text).not.toContain("stale source without assumptions");
  });
  it.each([
    "example : False := by sorry",
    "axiom forged : False\nexample : False := forged",
    'def marker : Nat := dbg_trace "{ "/-" }"; 0\nexample : False := by sorry',
    'def marker : Nat := dbg_trace "{ "/-" }"; 0\n#eval IO.println "scanner-bypass"',
    'def marker : Nat := dbg_trace "{ "/-" }"; 0\naxiom forged : False',
  ])("retains rejected model output but never sends it to a compiler: %s", async (code) => {
    const verifier = new QueueVerifier([verified]);
    const model: ProofModel = {translate:async()=>({...initial,leanCode:code}),repair:async()=>repaired};
    const pipeline = new ProofPipeline({model,verifier});
    const job = pipeline.start({...source,autoRepair:false});
    await pipeline.run(job.id);
    expect(verifier.calls).toHaveLength(0);
    expect(pipeline.get(job.id)).toMatchObject({status:"failed",translation:{leanCode:code},verification:{ok:false,status:"failed",command:"Lean source validation (not compiled)"}});
    expect(pipeline.get(job.id)?.verification?.output).toMatch(/placeholder|unsafe/);
  });

  it("repairs a source rejection using the retained model output before compiling", async () => {
    const verifier = new QueueVerifier([verified]);
    const contexts: RepairContext[] = [];
    const code = "example : False := by sorry";
    const model: ProofModel = {translate:async()=>({...initial,leanCode:code}),repair:async context=>{contexts.push(context);return repaired;}};
    const pipeline = new ProofPipeline({model,verifier,maxRepairAttempts:1});
    const job = pipeline.start(source);
    await pipeline.run(job.id);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.translation.leanCode).toBe(code);
    expect(contexts[0]?.diagnostics).toMatch(/placeholder/);
    expect(verifier.calls.map(call=>call.code)).toEqual([repaired.leanCode]);
    expect(pipeline.get(job.id)).toMatchObject({status:"verified",translation:repaired});
    expect(pipeline.get(job.id)?.attempts).toHaveLength(2);
  });

  it("verifies supplied Lean without calling the model", async () => {
    const {pipeline,model,verifier}=harness([verified]);
    model.failure=new Error("AI must not run");
    const result=await pipeline.verifyCode("example : True := by trivial");
    expect(result.status).toBe("verified");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.kind).toBe("manual");
    expect(verifier.calls[0]?.code).toBe("example : True := by trivial");
    expect(model.repairs).toHaveLength(0);
    await expect(pipeline.verifyCode("example : False := by sorry")).rejects.toThrow(/placeholder/);
  });
  it("finishes a valid initial translation", async () => {
    const { pipeline, verifier } = harness([verified]);
    const job = pipeline.start(source);

    await pipeline.run(job.id);

    expect(pipeline.get(job.id)).toMatchObject({
      status: "verified",
      translation: initial,
      verification: { ok: true },
    });
    expect(verifier.calls[0]?.options).toEqual({ timeoutMs: 1_234, projectPath: "/tmp/mathlib" });
  });

  it("repairs a compiler failure and finishes verified", async () => {
    const { pipeline, model, verifier } = harness([failed, verified]);
    const job = pipeline.start(source);

    await pipeline.run(job.id);

    const result = pipeline.get(job.id);
    expect(result?.status).toBe("verified");
    expect(result?.attempts.map(({ kind }) => kind)).toEqual(["initial", "repair"]);
    expect(model.repairs).toHaveLength(1);
    expect(model.repairs[0]?.diagnostics).toContain("unknown identifier");
    expect(verifier.calls).toHaveLength(2);
  });

  it("preserves the latest code when repairs are exhausted", async () => {
    const { pipeline, model } = harness([failed, failed, failed], 2);
    const job = pipeline.start(source);

    await pipeline.run(job.id);

    const result = pipeline.get(job.id);
    expect(result).toMatchObject({ status: "failed", translation: repaired });
    expect(result?.attempts).toHaveLength(3);
    expect(model.repairs).toHaveLength(2);
  });

  it("does not repair when auto repair is disabled", async () => {
    const { pipeline, model } = harness([failed]);
    const job = pipeline.start({ ...source, autoRepair: false });

    await pipeline.run(job.id);

    expect(pipeline.get(job.id)?.status).toBe("failed");
    expect(model.repairs).toHaveLength(0);
  });

  it.each(["timeout", "missing"] as const)("preserves a %s result without spending model calls on an infrastructure failure", async (status) => {
    const result = { ...failed, status, output: `Lean ${status}` };
    const { pipeline, model, verifier } = harness([result]);
    const job = pipeline.start(source);

    await pipeline.run(job.id);

    expect(pipeline.get(job.id)).toMatchObject({ status: "failed", verification: result, translation: initial });
    expect(model.repairs).toHaveLength(0);
    expect(verifier.calls).toHaveLength(1);
  });

  it("records a redacted structured provider failure", async () => {
    const { pipeline, model } = harness([]);
    model.failure = Object.assign(
      new Error("Incorrect API key sk-proj-super-secret"),
      { status: 401, code: "invalid_api_key", type: "invalid_request_error" },
    );
    const job = pipeline.start(source);

    await pipeline.run(job.id);

    const result = pipeline.get(job.id);
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/status=401.*code=invalid_api_key.*type=invalid_request_error/),
    });
    expect(result?.error).toContain("sk-[redacted]");
    expect(result?.error).not.toContain("super-secret");
  });

  it("re-verifies manually edited Lean without calling the model", async () => {
    const { pipeline, model } = harness([verified, verified]);
    const job = pipeline.start(source);
    await pipeline.run(job.id);

    const updated = await pipeline.reverify(job.id, "theorem manual : True := by trivial");

    expect(updated.status).toBe("verified");
    expect(updated.attempts.at(-1)).toMatchObject({ kind: "manual", verification: { ok: true } });
    expect(model.repairs).toHaveLength(0);
  });

  it("does not grow translation notes across repeated manual verification", async () => {
    const { pipeline } = harness([verified]);
    const job = pipeline.start(source);
    await pipeline.run(job.id);

    let updated = pipeline.get(job.id);
    for (let index = 0; index < 100; index += 1) {
      updated = await pipeline.reverify(job.id, "theorem manual : True := by trivial");
    }

    expect(updated?.translation?.notes).toHaveLength(1);
    expect(updated?.translation?.notes[0]).toMatch(/用户手动编辑后重新验证/);
    expect(updated?.attempts).toHaveLength(4);
  });
});
