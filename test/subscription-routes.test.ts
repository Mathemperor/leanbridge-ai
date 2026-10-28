import {describe,it,expect,vi} from "vitest";
import request from "supertest";
import {createApp} from "../src/server/app";
import {ProofPipeline} from "../src/server/domain/proof-pipeline";
import {DemoProofModel} from "../src/server/adapters/model/demo-proof-model";
import {DemoLeanVerifier} from "../src/server/adapters/lean/demo-verifier";
import {loadConfig,toPublicConfig} from "../src/server/config";
const ticket="t".repeat(43),state="s".repeat(43);
function fixture(){
 const session={status:vi.fn(async()=>({connected:false,state:"idle" as const})),startLogin:vi.fn(async()=>({connected:false,state:"pending" as const})),inspectLogin:vi.fn(async()=>({authorizationUrl:"https://auth.openai.com/api/accounts/authorize?state="+state})),completeLogin:vi.fn(async()=>({connected:true,state:"connected" as const,transport:"chatgpt-plan" as const}))};
 const config=loadConfig({CLOUD_MODE:"true",MODEL_PROVIDER:"codex",LEAN_VERIFIER:"leanweb",LEANBRIDGE_BACKEND_TOKEN:"test-backend-token"});
 const pipeline=new ProofPipeline({model:new DemoProofModel(),verifier:new DemoLeanVerifier(),maxRepairAttempts:0,verifyDefaults:{}});
 const app=createApp({pipeline,publicConfig:toPublicConfig(config),backendToken:"test-backend-token",cloudMode:true,codexSession:session,subscriptionSession:session});return {app,session};
}
describe("subscription OAuth route boundary",()=>{
 it("public config identifies direct transport without exposing private auth configuration or using an API key",()=>{
  const config=loadConfig({CLOUD_MODE:"true",MODEL_PROVIDER:"codex",LEAN_VERIFIER:"leanweb",LEANBRIDGE_BACKEND_TOKEN:"test-backend-token",OPENAI_API_KEY:"UNUSED_TEST_KEY",CHATGPT_PLAN_CLIENT_ID:"oaiapp_test",CHATGPT_PLAN_AUTH_DIR:"/private/auth"});
  expect(config.apiKey).toBeUndefined();const publicConfig=toPublicConfig(config);expect(publicConfig.subscriptionTransport).toBe("chatgpt-plan");expect(JSON.stringify(publicConfig)).not.toMatch(/UNUSED_TEST_KEY|oaiapp_test|private\/auth/);
 });
 it("keeps begin/status protected while a valid one-use-ticket inspect reaches the session",async()=>{
  const {app,session}=fixture();expect((await request(app).post("/api/codex/login").send({})).status).toBe(401);expect(session.startLogin).not.toHaveBeenCalled();
  const inspected=await request(app).post("/api/subscription/inspect").send({ticket,state});expect(inspected.status).toBe(200);expect(session.inspectLogin).toHaveBeenCalledWith({ticket,state});
 });
 it("rejects unknown input/large callbacks and returns only public auth state",async()=>{
  const {app,session}=fixture();
  expect((await request(app).post("/api/subscription/callback").send({ticket,state,code:"code",access_token:"SECRET"})).status).toBe(400);expect(session.completeLogin).not.toHaveBeenCalled();
  expect((await request(app).post("/api/subscription/callback").send({ticket,state,code:"x".repeat(30000)})).status).toBe(413);
  const done=await request(app).post("/api/subscription/callback").send({ticket,state,code:"code",clientId:"oaiapp_test"});expect(done.status).toBe(200);expect(done.body).toMatchObject({connected:true,state:"connected",transport:"chatgpt-plan"});
  expect(done.headers["cache-control"]).toBe("no-store");expect(JSON.stringify(done.body)).not.toMatch(/ticket|access_token|refresh_token|code/);
 });
 it("does not expose raw callback errors",async()=>{
  const {app,session}=fixture();session.completeLogin.mockRejectedValueOnce(new Error("DO_NOT_DISCLOSE_REFRESH_TOKEN"));
  const failed=await request(app).post("/api/subscription/callback").send({ticket,state,code:"code"});expect(failed.status).toBe(400);expect(JSON.stringify(failed.body)).not.toContain("DO_NOT_DISCLOSE");
 });
});
