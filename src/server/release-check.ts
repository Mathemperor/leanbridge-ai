import {mkdir,open} from "node:fs/promises";
import {join} from "node:path";
import {ChatGPTPlanProofModel,type PlanModelSession} from "./adapters/model/chatgpt-plan-model";
import {PlanResponseError} from "./adapters/model/plan-stream";
import {ProofPipeline} from "./domain/proof-pipeline";
import type {LeanVerifier,VerifyOptions} from "./domain/ports";
import {runTierCapabilityCheck} from "./tier-capability-check";
import type {PlanTierCapability} from "./adapters/model/chatgpt-plan-session";

interface Options {
  id:string;before:string;directory:string;profile?:string;
  session:PlanModelSession & {inspectTierCatalog?:(signal?:AbortSignal)=>Promise<PlanTierCapability[]>};verifier:LeanVerifier;verifyDefaults:VerifyOptions;
  fetchImpl?:typeof fetch;log:(result:Record<string,unknown>)=>void;
}

/** Explicit, temporary release diagnostics. No endpoint, tokens or proof text are exposed.
 * Claim before inference so restarts never repeat allowance use for the same check ID. */
export async function runSubscriptionReleaseCheck(options:Options):Promise<void> {
  if(options.profile!==undefined&&options.profile!=="compatibility"&&options.profile!=="tier-capabilities-v1")return;
  const deadline=Date.parse(options.before);
  if (!/^fast-\d{8}-[a-z0-9]{1,16}$/.test(options.id)||!Number.isFinite(deadline)||deadline<=Date.now()||deadline>Date.now()+24*60*60*1000) return;
  await mkdir(options.directory,{recursive:true,mode:0o700});
  try {const claim=await open(join(options.directory,`release-${options.id}.claimed`),"wx",0o600);await claim.close();}
  catch(error){if(error&&typeof error==="object"&&"code" in error&&error.code==="EEXIST")return;throw new Error("RELEASE_CHECK_STORAGE_FAILED");}
  if(options.profile==="tier-capabilities-v1")return runTierCapabilityCheck({...options,deadline});
  const variants=[{name:"legacy"},{name:"standard",speed:"standard"},{name:"fast",speed:"fast"},{name:"priority-alias",speed:"fast"}] as const;
  for(const variant of variants){
    if(Date.now()>=deadline)break;
    let failure:PlanResponseError|undefined;
    const transport:typeof fetch=async(url,init)=>{
      if((variant.name==="fast"||variant.name==="priority-alias")&&String(url)==="https://api.openai.com/v1/responses"&&init?.body){
        const body=JSON.parse(String(init.body));
        if(body.service_tier==="fast"||body.service_tier==="priority")return (options.fetchImpl??fetch)(url,{...init,body:JSON.stringify({...body,service_tier:variant.name==="fast"?"fast":"priority"})});
      }
      return (options.fetchImpl??fetch)(url,init);
    };
    const adapter=new ChatGPTPlanProofModel({model:"gpt-6-astra",reasoningEffort:"max",timeoutMs:90_000},options.session,transport);
    const pipeline=new ProofPipeline({model:{translate:async source=>{try{return await adapter.translate(source);}catch(error){if(error instanceof PlanResponseError)failure=error;throw error;}},repair:context=>adapter.repair(context)},verifier:options.verifier,verifyDefaults:options.verifyDefaults,maxRepairAttempts:0});
    const job=pipeline.start({mode:"latex",latex:"Prove for every n : Nat, n + 0 = n. Use rfl. Name the theorem release_nat.",model:"gpt-6-astra",reasoningEffort:"max",autoRepair:false,...("speed" in variant?{speed:variant.speed}:{})});
    await pipeline.run(job.id);
    const result=pipeline.get(job.id)!;
    options.log({checkId:options.id,variant:variant.name,model:"gpt-6-astra",reasoningEffort:"max",status:result.status,
      ...(result.translation?.serviceTier?{serviceTier:result.translation.serviceTier}:{}),
      ...(result.verification?{lean:{ok:result.verification.ok,status:result.verification.status,durationMs:result.verification.durationMs}}:{}),
      ...(failure?{error:{code:failure.code,status:failure.status,upstreamCode:failure.upstreamCode,param:failure.param,providerType:failure.providerType,bodyShape:failure.bodyShape,requestId:failure.requestId}}:{})});
    // Shared auth, quota, model or transport failures invalidate further controls.
    // Only a request-level 400 or explicit tier rejection justifies alias comparison.
    if(failure&&!(failure.status===400&&(failure.code==="CODEX_SPEED_UNAVAILABLE"||failure.code==="CODEX_RESPONSE_FAILED")))break;
    if(!failure&&result.status!=="verified"&&(!result.verification||result.verification.status!=="failed"))break;
  }
}
