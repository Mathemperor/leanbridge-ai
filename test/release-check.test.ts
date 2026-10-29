import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {runSubscriptionReleaseCheck} from "../src/server/release-check";

const directories:string[]=[];
afterEach(async()=>{for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
const translation={normalizedSource:"n+0=n",theoremSummary:"addition",assumptions:[],imports:[],leanCode:"theorem release_nat (n : Nat) : n + 0 = n := by rfl",notes:[]};
const session={catalog:async()=>[{slug:"gpt-6-astra",visibility:"list"}],accessToken:async()=>"private-token"};
const verifier={verify:async()=>({ok:true,status:"verified" as const,command:"test compiler",durationMs:5,output:"",diagnostics:[]})};
async function directory(){const dir=await mkdtemp(join(tmpdir(),"leanbridge-release-"));directories.push(dir);return dir;}
function completed(tier:string){return new Response(`data: ${JSON.stringify({type:"response.completed",response:{status:"completed",service_tier:tier,output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(translation)}]}]}})}\n\n`);}

describe("one-shot subscription release check",()=>{
  it("checks independent omitted/default/fast/priority requests once without changing model or effort",async()=>{
    const dir=await directory(),requests:Array<Record<string,unknown>>=[],logs:unknown[]=[];
    const options={id:"fast-20261029-diag1",before:new Date(Date.now()+60000).toISOString(),directory:dir,session,verifier,verifyDefaults:{},log:(value:unknown)=>logs.push(value),fetchImpl:(async(_url,init)=>{const body=JSON.parse(String(init?.body));requests.push(body);return completed(body.service_tier??"default");}) as typeof fetch};
    await runSubscriptionReleaseCheck(options);
    await runSubscriptionReleaseCheck(options);
    expect(requests.map(x=>x.service_tier)).toEqual([undefined,"default","fast","priority"]);
    expect(requests.every(x=>x.model==="gpt-6-astra"&&JSON.stringify(x.reasoning)==='{"effort":"max"}'&&x.store===false&&x.stream===true)).toBe(true);
    expect(logs).toHaveLength(4);
    expect(JSON.stringify(logs)).not.toMatch(/private-token|normalizedSource|leanCode/);
  });
  it("logs safe rejection categories separately from successful control results",async()=>{
    const logs:Array<Record<string,unknown>>=[];
    await runSubscriptionReleaseCheck({id:"fast-20261029-diag2",before:new Date(Date.now()+60000).toISOString(),directory:await directory(),session,verifier,verifyDefaults:{},log:x=>logs.push(x),fetchImpl:async(_url,init)=>{
      const body=JSON.parse(String(init?.body));
      return body.service_tier==="fast"?Response.json({error:{code:null,type:"invalid_request_error",param:"service_tier",message:"private-proof Bearer private-token"}},{status:400}):completed(body.service_tier??"default");
    }});
    expect(logs.map(x=>x.status)).toEqual(["verified","verified","failed","verified"]);
    expect(logs[2]).toMatchObject({variant:"fast",error:{code:"CODEX_SPEED_UNAVAILABLE",param:"service_tier",bodyShape:"error"}});
    expect(JSON.stringify(logs)).not.toMatch(/private-proof|private-token|leanCode/);
  });
  it("does nothing when the temporary probe id or deadline is invalid or expired",async()=>{
    let calls=0;const dir=await directory();
    for(const change of [{id:"../escape",before:new Date(Date.now()+60000).toISOString()},{id:"fast-20261029-expired",before:"2026-01-01T00:00:00Z"},{id:"fast-20261029-invalid",before:"invalid"}]){
      await runSubscriptionReleaseCheck({...change,directory:dir,session,verifier,verifyDefaults:{},log:()=>{calls++;},fetchImpl:async()=>{calls++;return completed("fast");}});
    }
    expect(calls).toBe(0);
  });
  it.each([401,403,429,503])("stops independent controls after a shared admission/usage failure %s",async status=>{
    let calls=0;const logs:unknown[]=[];
    await runSubscriptionReleaseCheck({id:`fast-20261029-stop${status}`,before:new Date(Date.now()+60000).toISOString(),directory:await directory(),session,verifier,verifyDefaults:{},log:x=>logs.push(x),fetchImpl:async()=>{calls++;return Response.json({error:{message:"private-token"}},{status});}});
    expect(calls).toBe(1);
    expect(logs).toHaveLength(1);
  });
  it("stops controls after a compiler outage or timeout but retains the upstream tier",async()=>{
    let calls=0;const logs:Array<Record<string,unknown>>=[];
    await runSubscriptionReleaseCheck({id:"fast-20261029-leanoutage",before:new Date(Date.now()+60000).toISOString(),directory:await directory(),session,verifyDefaults:{},verifier:{verify:async()=>({ok:false,status:"timeout",command:"LeanWeb",durationMs:1000,output:"private-proof",diagnostics:[]})},log:x=>logs.push(x),fetchImpl:async()=>{calls++;return completed("default");}});
    expect(calls).toBe(1);
    expect(logs[0]).toMatchObject({serviceTier:"default",lean:{status:"timeout",ok:false}});
    expect(JSON.stringify(logs)).not.toContain("private-proof");
  });
});
