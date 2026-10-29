import {normalizeLeanCode} from "@shared/proof";
import type {ModelServiceTier} from "@shared/codex-options";
import type {PlanModelSession} from "./adapters/model/chatgpt-plan-model";
import type {PlanTierCapability} from "./adapters/model/chatgpt-plan-session";
import {PlanResponseError,readPlanStream} from "./adapters/model/plan-stream";
import {PLAN_REQUEST_IDENTITY} from "./adapters/model/plan-request-identity";
import {ProofPipeline} from "./domain/proof-pipeline";
import type {LeanVerifier,VerifyOptions} from "./domain/ports";

interface Options {
  id:string;deadline:number;identityControl?:boolean;
  session:PlanModelSession & {inspectTierCatalog?:(signal?:AbortSignal)=>Promise<PlanTierCapability[]>};
  verifier:LeanVerifier;verifyDefaults:VerifyOptions;fetchImpl?:typeof fetch;
  log:(result:Record<string,unknown>)=>void;
}
const TIER_IDS=["default","priority","fast","ultrafast","auto"];
const TIER_FIELDS=["service_tiers","additional_speed_tiers","default_service_tier","serviceTiers","additionalSpeedTiers","defaultServiceTier"];
const selectedModels=["gpt-6-astra","gpt-5.6-sol"];
const prompt="Prove for every n : Nat, n + 0 = n. Use rfl. Name the theorem release_nat. Return only the complete Lean 4 code, without commentary.";

// Cancelling a diagnostic wait must not cancel a rotating grant's durable write.
// No further inference starts after cancellation; the session may finish its own refresh safely.
function within<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener("abort",abort);reject(new PlanResponseError("CODEX_TIMEOUT"));};
    signal.addEventListener("abort",abort,{once:true});
    if(signal.aborted){abort();return;}
    Promise.resolve().then(()=>{signal.throwIfAborted();return work();}).then(value=>{signal.removeEventListener("abort",abort);resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});
  });
}

/** Static lexical hints only. Never copy provider text, submitted proofs or credentials to logs. */
async function errorClues(response:Response):Promise<Record<string,unknown>> {
  const reader=response.body?.getReader();if(!reader)return {detailType:"unavailable",mentions:[]};
  let bytes=0,text="";const decoder=new TextDecoder();
  try {
    for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>16*1024)return {detailType:"unavailable",mentions:[],truncated:true};text+=decoder.decode(chunk.value,{stream:true});}
    const body=JSON.parse(text+decoder.decode());
    const detail=body&&typeof body==="object"&&!Array.isArray(body)?body.detail:undefined;
    const detailType=typeof detail==="string"?"string":Array.isArray(detail)?"array":detail&&typeof detail==="object"?"object":"absent";
    const clues:[string,RegExp][]=[["service_tier",/service[_ -]tier/i],["fast",/\bfast\b/i],["priority",/\bpriority\b/i],["default",/\bdefault\b/i],["unsupported",/\bunsupported\b|not supported/i],["not_allowed",/not allowed|not permitted|forbidden/i],["permission",/\bpermission\b/i],["subscription",/\bsubscription\b/i]];
    return {detailType,mentions:clues.filter(([,pattern])=>pattern.test(text)).map(([name])=>name)};
  } catch {return {detailType:"unavailable",mentions:[]};}
  finally {void reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Caller has already claimed the ID durably. This function has no public endpoint. */
export async function runTierCapabilityCheck(options:Options):Promise<void> {
  const profile=options.identityControl?"request-identity-v1":"tier-capabilities-v1";
  if(Date.now()>=options.deadline)return;
  const overallSignal=AbortSignal.timeout(Math.max(1,options.deadline-Date.now()));
  let visible:string[];
  try {
    if(options.session.inspectTierCatalog){
      const catalog=await within(overallSignal,()=>options.session.inspectTierCatalog!(overallSignal));visible=catalog.map(row=>row.slug);
      options.log({checkId:options.id,profile,phase:"catalog",models:catalog.filter(row=>selectedModels.includes(row.slug)).map(row=>({
        model:row.slug,serviceTiers:row.serviceTiers.filter(tier=>TIER_IDS.includes(tier)),additionalSpeedTiers:row.additionalSpeedTiers.filter(tier=>TIER_IDS.includes(tier)),
        ...(row.defaultServiceTier&&TIER_IDS.includes(row.defaultServiceTier)?{defaultServiceTier:row.defaultServiceTier}:{}),metadataFields:row.metadataFields.filter(field=>TIER_FIELDS.includes(field)),
      }))});
    }else{visible=(await within(overallSignal,()=>options.session.catalog())).filter(row=>row.visibility==="list").map(row=>row.slug);options.log({checkId:options.id,profile,phase:"catalog",status:"metadata-unavailable"});}
  } catch {options.log({checkId:options.id,phase:"catalog",status:"unavailable"});return;}
  if(!visible.includes("gpt-6-astra")){options.log({checkId:options.id,phase:"catalog",status:"model-unavailable"});return;}
  const variants=options.identityControl
    ?[{name:"priority-without-identity",tier:"priority",identity:false},{name:"priority-with-app-identity",tier:"priority",identity:true}]
    :["default","priority","fast"].map(tier=>({name:`minimal-${tier}`,tier,identity:false}));
  for(const variant of variants){
    const tier=variant.tier;
    if(Date.now()>=options.deadline)break;
    let failure:PlanResponseError|undefined,clues:Record<string,unknown>|undefined;
    const pipeline=new ProofPipeline({model:{translate:async()=>{
      const signal=AbortSignal.any([overallSignal,AbortSignal.timeout(Math.max(1,Math.min(90_000,options.deadline-Date.now())))]);
      try {
        const token=await within(signal,()=>options.session.accessToken());if(!token)throw new PlanResponseError("CODEX_AUTH_REQUIRED");
        if(signal.aborted)throw new PlanResponseError("CODEX_TIMEOUT");
        const response=await within(signal,()=>(options.fetchImpl??fetch)("https://api.openai.com/v1/responses",{method:"POST",redirect:"error",signal,
          headers:{...(variant.identity?PLAN_REQUEST_IDENTITY:{}),Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
          body:JSON.stringify({model:"gpt-6-astra",reasoning:{effort:"max"},service_tier:tier,input:[{role:"user",content:[{type:"input_text",text:prompt}]}],store:false,stream:true})}));
        if(!response.ok)clues=await within(signal,()=>errorClues(response.clone()));
        let actual:ModelServiceTier|undefined;
        const code=await within(signal,()=>readPlanStream(response,{signal,onCompleted:metadata=>{actual=metadata.serviceTier;}}));
        return {normalizedSource:"n + 0 = n",theoremSummary:"Natural number addition control",assumptions:[],imports:[],notes:[],leanCode:normalizeLeanCode(code),...(actual?{serviceTier:actual}:{})};
      }catch(error){
        failure=error instanceof PlanResponseError?error:new PlanResponseError(signal.aborted?"CODEX_TIMEOUT":error instanceof Error&&error.message==="PLAN_RECONNECT_REQUIRED"?"CODEX_AUTH_REQUIRED":"CODEX_UPSTREAM_UNAVAILABLE");
        throw failure;
      }
    },repair:async()=>{throw new PlanResponseError("CODEX_RESPONSE_FAILED");}},verifier:{verify:async(code,verifyOptions)=>{
      const started=Date.now(),remaining=options.deadline-started;
      const timeout=()=>({ok:false,status:"timeout" as const,command:"release check deadline",durationMs:Date.now()-started,output:"Release check deadline reached.",diagnostics:[]});
      if(remaining<=0||overallSignal.aborted)return timeout();
      const configured=verifyOptions.timeoutMs&&Number.isFinite(verifyOptions.timeoutMs)&&verifyOptions.timeoutMs>0?verifyOptions.timeoutMs:120_000;
      try{return await within(overallSignal,()=>options.verifier.verify(code,{...verifyOptions,timeoutMs:Math.min(configured,remaining)}));}
      catch(error){if(overallSignal.aborted)return timeout();throw error;}
    }},verifyDefaults:options.verifyDefaults,maxRepairAttempts:0});
    const job=pipeline.start({mode:"latex",latex:prompt,model:"gpt-6-astra",reasoningEffort:"max",autoRepair:false});
    await pipeline.run(job.id);const result=pipeline.get(job.id)!;
    options.log({checkId:options.id,profile,variant:variant.name,model:"gpt-6-astra",reasoningEffort:"max",status:result.status,
      ...(result.translation?.serviceTier?{serviceTier:result.translation.serviceTier}:{}),
      ...(result.verification?{lean:{ok:result.verification.ok,status:result.verification.status,durationMs:result.verification.durationMs}}:{}),
      ...(failure?{error:{code:failure.code,status:failure.status,upstreamCode:failure.upstreamCode,param:failure.param,providerType:failure.providerType,bodyShape:failure.bodyShape,requestId:failure.requestId}}:{}),...(clues?{errorClues:clues}:{})});
    if(failure&&!(failure.status===400&&(failure.code==="CODEX_SPEED_UNAVAILABLE"||failure.code==="CODEX_RESPONSE_FAILED")))break;
    if(!failure&&result.status!=="verified"&&(!result.verification||result.verification.status!=="failed"))break;
  }
}
