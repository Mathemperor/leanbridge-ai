import { describe, expect, it } from "vitest";
import { readFile, writeFile, stat } from "node:fs/promises";
import { CodexProofModel, codexEnvironment, parseDeviceLogin, runCodexCommand } from "./codex-proof-model";
import { loadConfig } from "../../config";

const translation = { normalizedSource: "n + 0 = n", theoremSummary: "加零", assumptions: [], imports: [], leanCode: "example (n : Nat) : n + 0 = n := by rfl", notes: [] };
const transcription = {problemText:"Prove addition",problemLatex:"n+0=n",solutionText:"By reflexivity",solutionLatex:"rfl",uncertainties:["Bottom line cropped"]};
describe("Codex subscription adapter", () => {
  it("ends the entire launcher process tree at the deadline", async () => {
    const started=Date.now();
    const program='const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setTimeout(()=>{},5000)"],{stdio:["ignore","inherit","inherit"]});child.on("spawn",()=>console.log("child-ready:"+child.pid));setTimeout(()=>{},10000);';
    const result=await runCodexCommand(process.execPath,["-e",program],{timeoutMs:1000});
    expect(result.stdout).toContain("child-ready");
    expect(result.timedOut).toBe(true);
    expect(Date.now()-started).toBeLessThan(3500);
    const pid=Number(result.stdout.match(/child-ready:(\d+)/)?.[1]);
    await new Promise(resolve=>setTimeout(resolve,100));
    let running=false;
    try {process.kill(pid,0);running=true;if(process.platform==="linux")running=!/\) Z /.test(await readFile(`/proc/${pid}/stat`,"utf8"));} catch { /* The process has been reaped. */ }
    expect(running).toBe(false);
  },10000);
  it("accepts Codex configuration without any API key and ignores leftover API keys", () => {
    const config = loadConfig({ MODEL_PROVIDER: "codex", OPENAI_API_KEY: "unused-api-key", CODEX_MODEL: "gpt-6-astra" });
    expect(config.provider).toBe("codex"); expect(config.apiKey).toBeUndefined(); expect(config.model).toBe("gpt-6-astra");
    expect(() => loadConfig({ MODEL_PROVIDER: "codex" })).not.toThrow();
  });
  it("passes only CLI runtime environment, never app credentials or API key fallback", () => {
    const env = codexEnvironment({ PATH:"/bin", HOME:"/home/leanbridge", CODEX_HOME:"/data/codex", OPENAI_API_KEY:"secret", CODEX_API_KEY:"secret2", LEANBRIDGE_BACKEND_TOKEN:"private", LEANBRIDGE_SECRET_FILE:"/tmp/private" });
    expect(env).toMatchObject({PATH:"/bin",CODEX_HOME:"/data/codex"});
    expect(JSON.stringify(env)).not.toMatch(/secret|private/);
  });
  it("runs a bounded read-only CLI job with structured output and no shell tool", async () => {
    let temporary="";
    const model = new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"high"}, async (_command,args,options) => {
      expect(args).toContain("--ephemeral"); expect(args).toContain("read-only"); expect(args).toContain("features.shell_tool=false");
      expect(options.input).toContain("Prove n + 0 = n");
      const destination=args[args.indexOf("--output-last-message")+1]!;temporary=destination;
      await writeFile(destination,JSON.stringify(translation));
      return {code:0,stdout:"",stderr:"",timedOut:false};
    });
    expect(await model.translate({mode:"latex",latex:"Prove n + 0 = n",autoRepair:true})).toEqual(translation);
    await expect(stat(temporary)).rejects.toThrow();
  });
  it("uses the configured generation deadline for complex proofs", async () => {
    const model=new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"max",timeoutMs:900000},async(_command,args,options)=>{
      expect(options.timeoutMs).toBe(900000);
      await writeFile(args[args.indexOf("--output-last-message")+1]!,JSON.stringify(translation));
      return {code:0,stdout:"",stderr:"",timedOut:false};
    });
    await expect(model.translate({mode:"latex",latex:"test",autoRepair:false})).resolves.toEqual(translation);
  });
  it("returns a structured candidate for the pipeline to retain and validate before execution", async () => {
    const candidate={...translation,leanCode:"example : False := by sorry"};
    const model=new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"max"},async(_command,args)=>{
      await writeFile(args[args.indexOf("--output-last-message")+1]!,JSON.stringify(candidate));
      return {code:0,stdout:"",stderr:"",timedOut:false};
    });
    await expect(model.translate({mode:"latex",latex:"test",autoRepair:false})).resolves.toEqual(candidate);
  });
  it("attaches image bytes to Codex and does not put them in the text prompt", async () => {
    const model = new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"high"}, async (_c,args,options) => {
      expect((await readFile(args[args.indexOf("--image")+1]!)).toString()).toBe("test-image");
      expect(options.input).not.toContain("dGVzdC1pbWFnZQ==");
      expect(options.timeoutMs).toBe(180000);
      expect(options.input).toContain("Never solve");
      expect(options.input).not.toContain("formalization engineer");
      const schema=JSON.parse(await readFile(args[args.indexOf("--output-schema")+1]!,"utf8"));
      expect(schema.required).toEqual(["problemText","problemLatex","solutionText","solutionLatex","uncertainties"]);
      expect(schema.properties.problemText.maxLength).toBe(8000);
      expect(schema.properties.uncertainties.maxItems).toBe(20);
      await writeFile(args[args.indexOf("--output-last-message")+1]!,JSON.stringify(transcription));
      return {code:0,stdout:"",stderr:"",timedOut:false};
    });
    expect(await model.transcribeImage({mode:"image",imageDataUrl:"data:image/png;base64,dGVzdC1pbWFnZQ==",autoRepair:false})).toEqual(transcription);
  });
  it("explicitly rejects direct image formalization without running a command", async () => {
    let calls=0;
    const model=new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"high"},async()=>{calls++;throw new Error("must not run");});
    await expect(model.translate({mode:"image",imageDataUrl:"data:image/png;base64,dGVzdA==",autoRepair:false})).rejects.toThrow(/transcrib/i);
    expect(calls).toBe(0);
  });
  it.each([
    'private-image-content is not JSON',
    JSON.stringify({...transcription,problemText:"x".repeat(8001)}),
    JSON.stringify(translation),
  ])("rejects invalid recognition output categorically and removes temporary image files",async output=>{
    let directory="";
    const model=new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"high"},async(_command,args,options)=>{
      directory=options.cwd!;
      await writeFile(args[args.indexOf("--output-last-message")+1]!,output);
      return {code:0,stdout:"",stderr:"",timedOut:false};
    });
    await expect(model.transcribeImage({mode:"image",imageDataUrl:"data:image/png;base64,dGVzdA==",autoRepair:false})).rejects.toMatchObject({code:"CODEX_TRANSCRIPTION_INVALID",message:expect.not.stringContaining("private")});
    await expect(stat(directory)).rejects.toThrow();
  });
  it("keeps recognition and text jobs serialized with separate deadlines and cleans up recognition errors", async () => {
    let active=0, maximum=0; const paths:string[]=[];
    const model=new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"high",timeoutMs:900000,transcriptionTimeoutMs:30000},async(_command,args,options)=>{
      maximum=Math.max(maximum,++active);
      paths.push(options.cwd!);
      await new Promise(resolve=>setTimeout(resolve,10));
      if(args.includes("--image")){
        expect(options.timeoutMs).toBe(30000); active--;
        return {code:1,stdout:"",stderr:"private-recognition-payload",timedOut:true};
      }
      expect(options.timeoutMs).toBe(900000);
      await writeFile(args[args.indexOf("--output-last-message")+1]!,JSON.stringify(translation)); active--;
      return {code:0,stdout:"",stderr:"",timedOut:false};
    });
    const results=await Promise.allSettled([
      model.transcribeImage({mode:"image",imageDataUrl:"data:image/png;base64,dGVzdA==",autoRepair:false}),
      model.translate({mode:"latex",latex:"n+0=n",autoRepair:false}),
    ]);
    expect(results[0]).toMatchObject({status:"rejected",reason:{code:"CODEX_TIMEOUT"}});
    expect(results[1]).toMatchObject({status:"fulfilled",value:translation});
    expect(maximum).toBe(1);
    for(const path of paths) await expect(stat(path)).rejects.toThrow();
  });
  it("returns a safe quota error instead of exposing process stderr", async () => {
    const model = new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"high"}, async () => ({code:1,stdout:"",stderr:"usage_limit_reached bearer private-token",timedOut:false}));
    await expect(model.translate({mode:"latex",latex:"test",autoRepair:false})).rejects.toThrow(/订阅额度/);
  });
  it("recognizes an image rejection reported on stdout without blaming login", async () => {
    const model = new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"max"},async()=>({code:1,stdout:JSON.stringify({type:"error",message:"HTTP 400 invalid_image_format"}),stderr:"",timedOut:false}));
    await expect(model.translate({mode:"latex",latex:"test",autoRepair:false})).rejects.toMatchObject({code:"CODEX_IMAGE_REJECTED",status:400});
  });
  it("preserves process termination and an observed OOM separately from auth failures", async () => {
    const model = new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"max"},async()=>({code:null,signal:"SIGKILL",oomKilled:true,stdout:"",stderr:"",timedOut:false}));
    await expect(model.translate({mode:"latex",latex:"test",autoRepair:false})).rejects.toMatchObject({code:"CODEX_MEMORY_LIMIT",type:"exit_null_signal_SIGKILL"});
  });
  it("identifies a remote transport failure from structured CLI output", async () => {
    const model = new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"max"},async()=>({code:1,stdout:'{"type":"error","message":"unexpected status 503 Service Unavailable"}',stderr:"",timedOut:false}));
    await expect(model.translate({mode:"latex",latex:"test",autoRepair:false})).rejects.toMatchObject({code:"CODEX_UPSTREAM_UNAVAILABLE",status:503});
  });
  it("retains safe exit metadata for an unknown failure without emitting CLI content", async () => {
    const model = new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"max"},async()=>({code:2,stdout:"",stderr:"opaque private-secret prompt bytes",timedOut:false}));
    await expect(model.translate({mode:"latex",latex:"test",autoRepair:false})).rejects.toMatchObject({code:"CODEX_PROCESS_ERROR",type:"exit_2_signal_none"});
    await expect(model.translate({mode:"latex",latex:"test",autoRepair:false})).rejects.not.toThrow(/private-secret|订阅连接/);
  });
  it("only recognizes the official device authorization URL and one-time code", () => {
    expect(parseDeviceLogin("Visit https://auth.openai.com/codex/device\nEnter code: ABCD-12345")).toEqual({verificationUrl:"https://auth.openai.com/codex/device",userCode:"ABCD-12345"});
    expect(parseDeviceLogin("https://evil.example/codex/device ABCD-12345")).toBeNull();
    expect(parseDeviceLogin("https://auth.openai.com/codex/device.evil ABCD-12345")).toBeNull();
  });
});
