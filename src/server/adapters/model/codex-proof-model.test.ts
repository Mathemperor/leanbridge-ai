import { describe, expect, it } from "vitest";
import { readFile, writeFile, stat } from "node:fs/promises";
import { CodexProofModel, codexEnvironment, parseDeviceLogin } from "./codex-proof-model";
import { loadConfig } from "../../config";

const translation = { normalizedSource: "n + 0 = n", theoremSummary: "加零", assumptions: [], imports: [], leanCode: "example (n : Nat) : n + 0 = n := by rfl", notes: [] };
describe("Codex subscription adapter", () => {
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
  it("attaches image bytes to Codex and does not put them in the text prompt", async () => {
    const model = new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"high"}, async (_c,args,options) => {
      expect((await readFile(args[args.indexOf("--image")+1]!)).toString()).toBe("test-image");
      expect(options.input).not.toContain("dGVzdC1pbWFnZQ==");
      await writeFile(args[args.indexOf("--output-last-message")+1]!,JSON.stringify(translation));
      return {code:0,stdout:"",stderr:"",timedOut:false};
    });
    await model.translate({mode:"image",imageDataUrl:"data:image/png;base64,dGVzdC1pbWFnZQ==",autoRepair:false});
  });
  it("returns a safe quota error instead of exposing process stderr", async () => {
    const model = new CodexProofModel({model:"gpt-6-astra",reasoningEffort:"high"}, async () => ({code:1,stdout:"",stderr:"usage_limit_reached bearer private-token",timedOut:false}));
    await expect(model.translate({mode:"latex",latex:"test",autoRepair:false})).rejects.toThrow(/订阅额度/);
  });
  it("only recognizes the official device authorization URL and one-time code", () => {
    expect(parseDeviceLogin("Visit https://auth.openai.com/codex/device\nEnter code: ABCD-12345")).toEqual({verificationUrl:"https://auth.openai.com/codex/device",userCode:"ABCD-12345"});
    expect(parseDeviceLogin("https://evil.example/codex/device ABCD-12345")).toBeNull();
    expect(parseDeviceLogin("https://auth.openai.com/codex/device.evil ABCD-12345")).toBeNull();
  });
});
