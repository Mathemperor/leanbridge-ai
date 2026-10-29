import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {runSubscriptionReleaseCheck} from "../src/server/release-check";

const directories:string[]=[];
afterEach(async()=>{for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
const translation={normalizedSource:"n+0=n",theoremSummary:"addition",assumptions:[],imports:[],leanCode:"theorem release_nat (n : Nat) : n + 0 = n := by rfl",notes:[]};
const session={catalog:async()=>[{slug:"gpt-6-astra",visibility:"list"}],accessToken:async()=>"private-token"};
const verifier={verify:async()=>({ok:true,status:"verified" as const,command:"test compiler",durationMs:5,output:"",diagnostics:[]})};
async function directory(){const dir=await mkdtemp(join(tmpdir(),"leanbridge-release-"));directories.push(dir);return dir;}
function completed(tier:string){return new Response(`data: ${JSON.stringify({type:"response.completed",response:{status:"completed",service_tier:tier,output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(translation)}]}]}})}\n\n`);}
function plainCompleted(tier:string,text=translation.leanCode){return new Response(`data: ${JSON.stringify({type:"response.completed",response:{status:"completed",service_tier:tier,output:[{type:"message",content:[{type:"output_text",text}]}]}})}\n\n`);}

describe("one-shot subscription release check",()=>{
  it('compares exactly two identical priority bodies with and without real application attribution once',async()=>{
    const bodies:unknown[]=[],headers:Headers[]=[],logs:Array<Record<string,unknown>>=[];
    const options={profile:'request-identity-v1',id:'fast-20261029-identity1',before:new Date(Date.now()+60000).toISOString(),directory:await directory(),session,verifier,verifyDefaults:{},log:(x:Record<string,unknown>)=>logs.push(x),fetchImpl:(async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));headers.push(new Headers(init?.headers));return plainCompleted(headers.length===1?'default':'priority');}) as typeof fetch};
    await runSubscriptionReleaseCheck(options);await runSubscriptionReleaseCheck(options);
    expect(bodies).toHaveLength(2);expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({model:'gpt-6-astra',reasoning:{effort:'max'},service_tier:'priority',store:false,stream:true});
    expect(headers[0]!.get('originator')).toBeNull();expect(headers[1]!.get('originator')).toBe('LeanBridge AI');expect(headers[1]!.get('user-agent')).toBe('LeanBridgeAI/0.1.0');
    expect(logs.filter(x=>x.variant).map(x=>({variant:x.variant,serviceTier:x.serviceTier,status:x.status}))).toEqual([{variant:'priority-without-identity',serviceTier:'default',status:'verified'},{variant:'priority-with-app-identity',serviceTier:'priority',status:'verified'}]);
    expect(JSON.stringify(logs)).not.toMatch(/private-token|theorem release_nat|x-openai-internal/);
  });
  it.each(['catalog','token'])('ends the capability check at the overall deadline while %s is stalled',async phase=>{
    let calls=0;const never=new Promise<never>(()=>{});
    const check=runSubscriptionReleaseCheck({profile:'tier-capabilities-v1',id:`fast-20261029-dead${phase}`,before:new Date(Date.now()+100).toISOString(),directory:await directory(),
      session:{catalog:async()=>phase==='catalog'?never:[{slug:'gpt-6-astra',visibility:'list'}],accessToken:async()=>phase==='token'?never:'private-token'},verifier,verifyDefaults:{},log:()=>{},fetchImpl:async()=>{calls++;return plainCompleted('priority');}});
    const outcome=await Promise.race([check.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),350))]);
    expect(outcome).toBe(true);expect(calls).toBe(0);
  });
  it('caps the compiler timeout to the remaining overall deadline',async()=>{
    const timeouts:number[]=[];
    await runSubscriptionReleaseCheck({profile:'tier-capabilities-v1',id:'fast-20261029-compilecap',before:new Date(Date.now()+1000).toISOString(),directory:await directory(),session,
      verifier:{verify:async(_code,options)=>{timeouts.push(options.timeoutMs!);return verifier.verify();}},verifyDefaults:{timeoutMs:120000},log:()=>{},fetchImpl:async()=>plainCompleted('priority')});
    expect(timeouts).toHaveLength(3);expect(timeouts.every(timeout=>timeout>0&&timeout<=1000)).toBe(true);
  });
  it('never starts compilation or another inference after generation exhausted the deadline',async()=>{
    let now=Date.now(),calls=0,compiles=0;const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
    try{
      await runSubscriptionReleaseCheck({profile:'tier-capabilities-v1',id:'fast-20261029-nolatelean',before:new Date(now+1000).toISOString(),directory:await directory(),session,
        verifier:{verify:async()=>{compiles++;return verifier.verify();}},verifyDefaults:{timeoutMs:120000},log:()=>{},fetchImpl:async()=>{calls++;now+=1500;return plainCompleted('priority');}});
      expect(calls).toBe(1);expect(compiles).toBe(0);
    }finally{clock.mockRestore();}
  });
  it.each(['tier-capabilities-v1','compatibility','request-identity-v1'])('stops a shared 403 even if the provider also labels it a tier error: %s',async profile=>{
    let calls=0;
    await runSubscriptionReleaseCheck({profile,id:`fast-20261029-shared${profile==='compatibility'?1:2}`,before:new Date(Date.now()+60000).toISOString(),directory:await directory(),session,verifier,verifyDefaults:{},log:()=>{},
      fetchImpl:async()=>{calls++;return Response.json({error:{code:'unsupported_value',param:'service_tier'}},{status:403});}});
    expect(calls).toBe(1);
  });
  it('runs the minimal tier-capabilities profile once, compiles actual model output and preserves default as standard', async()=>{
    const requests:Array<Record<string,unknown>>=[],logs:Array<Record<string,unknown>>=[],compiled:string[]=[];
    let inspections=0;
    const options={profile:'tier-capabilities-v1',id:'fast-20261029-caps1',before:new Date(Date.now()+60000).toISOString(),directory:await directory(),session:{...session,inspectTierCatalog:async()=>{inspections++;return [{slug:'gpt-6-astra',serviceTiers:['priority'],additionalSpeedTiers:['fast'],metadataFields:['service_tiers']}];}},verifyDefaults:{},verifier:{verify:async(code:string)=>{compiled.push(code);return verifier.verify();}},log:(x:Record<string,unknown>)=>logs.push(x),fetchImpl:(async(url,init)=>{
      expect(String(url)).toBe('https://api.openai.com/v1/responses');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-token');
      const body=JSON.parse(String(init?.body));requests.push(body);return plainCompleted('default');
    }) as typeof fetch};
    await runSubscriptionReleaseCheck(options);await runSubscriptionReleaseCheck(options);
    expect(inspections).toBe(1);
    expect(requests.map(x=>x.service_tier)).toEqual(['default','priority','fast']);
    expect(requests.every(x=>x.model==='gpt-6-astra'&&JSON.stringify(x.reasoning)==='{"effort":"max"}'&&x.store===false&&x.stream===true&&!Object.hasOwn(x,'text'))).toBe(true);
    expect(new Set(requests.map(x=>JSON.stringify(x.input))).size).toBe(1);
    expect(compiled).toEqual(Array(3).fill(translation.leanCode));
    expect(logs.filter(x=>x.variant)).toEqual(expect.arrayContaining([expect.objectContaining({variant:'minimal-priority',status:'verified',serviceTier:'default'})]));
    expect(JSON.stringify(logs)).not.toMatch(/private-token|leanCode|theorem release_nat/);
  });
  it('fails closed for an unknown profile before catalog, token or inference access',async()=>{
    let calls=0;
    await runSubscriptionReleaseCheck({profile:'typo',id:'fast-20261029-unknown',before:new Date(Date.now()+60000).toISOString(),directory:await directory(),session:{catalog:async()=>{calls++;return [];},accessToken:async()=>{calls++;return 'private-token';}},verifier,verifyDefaults:{},log:()=>{calls++;},fetchImpl:async()=>{calls++;return plainCompleted('fast');}});
    expect(calls).toBe(0);
  });
  it('continues a request-level rejection with only fixed diagnostic clues, never provider prose',async()=>{
    const logs:Array<Record<string,unknown>>=[];
    await runSubscriptionReleaseCheck({profile:'tier-capabilities-v1',id:'fast-20261029-clues',before:new Date(Date.now()+60000).toISOString(),directory:await directory(),session,verifier,verifyDefaults:{},log:x=>logs.push(x),fetchImpl:async(_url,init)=>JSON.parse(String(init?.body)).service_tier==='fast'
      ?Response.json({detail:'Unsupported service_tier fast. Allowed values default, priority. Bearer private-token private-proof'},{status:400}):plainCompleted('default')});
    expect(logs.filter(x=>x.variant)).toHaveLength(3);
    expect(logs.find(x=>x.variant==='minimal-fast')).toMatchObject({status:'failed',error:{status:400,bodyShape:'detail'},errorClues:{detailType:'string',mentions:['service_tier','fast','priority','default','unsupported']}});
    expect(JSON.stringify(logs)).not.toMatch(/Bearer|private-token|private-proof|Allowed values/);
  });
  it.each([401,403,429,503])('stops minimal controls after shared admission failure %s',async status=>{
    let calls=0;const logs:Array<Record<string,unknown>>=[];
    await runSubscriptionReleaseCheck({profile:'tier-capabilities-v1',id:`fast-20261029-capstop${status}`,before:new Date(Date.now()+60000).toISOString(),directory:await directory(),session,verifier,verifyDefaults:{},log:x=>logs.push(x),fetchImpl:async()=>{calls++;return Response.json({error:{code:status===429?'rate_limit_exceeded':'server_error',message:'private-token'}},{status});}});
    expect(calls).toBe(1);expect(logs.filter(x=>x.variant)).toHaveLength(1);expect(JSON.stringify(logs)).not.toContain('private-token');
  });
  it('stops on compiler infrastructure failure and rejects unsafe model output before sending it to LeanWeb',async()=>{
    for(const unsafe of [false,true]){
      let calls=0,compiles=0;const logs:Array<Record<string,unknown>>=[];
      await runSubscriptionReleaseCheck({profile:'tier-capabilities-v1',id:`fast-20261029-caplean${unsafe?1:0}`,before:new Date(Date.now()+60000).toISOString(),directory:await directory(),session,verifyDefaults:{},verifier:{verify:async()=>{compiles++;return {ok:false,status:'timeout',command:'LeanWeb',durationMs:10,output:'private-proof',diagnostics:[]};}},log:x=>logs.push(x),fetchImpl:async()=>{calls++;return plainCompleted('priority',unsafe?'example : False := by sorry':translation.leanCode);}});
      expect(compiles).toBe(unsafe?0:1);expect(calls).toBe(unsafe?3:1);expect(JSON.stringify(logs)).not.toContain('private-proof');
    }
  });
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
