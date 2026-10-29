import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/server/app";
import { loadConfig, toPublicConfig } from "../src/server/config";
import { ProofPipeline } from "../src/server/domain/proof-pipeline";

const candidate={normalizedSource:"n+0=n",theoremSummary:"addition",assumptions:[],imports:[],leanCode:"example (n : Nat) : n + 0 = n := by rfl",notes:[]};
function fixture(provider="codex") {
  let calls=0;
  const pipeline=new ProofPipeline({model:{translate:async()=>{calls++;return candidate;},repair:async()=>candidate},verifier:{verify:async()=>({ok:true,status:"verified",command:"test Lean",durationMs:1,output:"",diagnostics:[]})}});
  return {app:createApp({pipeline,publicConfig:toPublicConfig(loadConfig({MODEL_PROVIDER:provider,...(provider==="openai"?{OPENAI_API_KEY:"test-only-unused"}:{})}))}),calls:()=>calls};
}
describe("proof speed selection",()=>{
  it("advertises Standard by default and accepts and records opt-in Fast",async()=>{
    const {app}=fixture();
    const config=await request(app).get("/api/config");
    expect(config.body.codexCatalog).toMatchObject({speeds:["standard","fast"],defaultSpeed:"standard"});
    const job=await request(app).post("/api/proofs").send({mode:"latex",latex:"n+0=n",speed:"fast"});
    expect(job.status).toBe(202);
    expect(job.body.modelConfig).toMatchObject({speed:"fast"});
    expect((await request(app).get(`/api/proofs/${job.body.id}`)).body.modelConfig.speed).toBe("fast");
  });
  it.each(["turbo",1.5,null])("rejects invalid speed %s before inference",async speed=>{
    const f=fixture();
    expect((await request(f.app).post("/api/proofs").send({mode:"latex",latex:"n+0=n",speed})).status).toBe(400);
    expect(f.calls()).toBe(0);
  });
  it("does not accept a speed setting on an unrelated billing provider",async()=>{
    const f=fixture("openai");
    expect((await request(f.app).post("/api/proofs").send({mode:"latex",latex:"n+0=n",speed:"fast"})).status).toBe(400);
    expect(f.calls()).toBe(0);
  });
});
